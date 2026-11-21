import { Op } from 'sequelize';
import db from '../../sequelize/models';
import Ticket from '../../sequelize/models/tickets.modal';
import TriageResult from '../../sequelize/models/triage_results.modal';
import TicketStatusHistory from '../../sequelize/models/ticket_status_history.modal';
import TicketEmbedding from '../../sequelize/models/ticket_embeddings.modal';
import { EMBEDDING_MODEL, MODEL_NAME, PROMPT_VERSION } from '../../config';
import {
  TRIAGE_STATUS,
  TICKET_STATUS_REASON,
  ticketProcessingReasonByPreviousStatus,
} from '../../modules/tickets/enum';
import { logger } from '../../logger';
import { cachedTriage, embedText } from '../triage';

/**
 * Claim and triage a ticket. The row lock is released before model inference.
 * processing_attempt fences completions from stale worker deliveries.
 */
export const processTicket = async (ticketId: number): Promise<boolean> => {
  let processingAttempt: number | undefined;

  await db.transaction(async (transaction) => {
    const ticket = await Ticket.findByPk(ticketId, { lock: transaction.LOCK.UPDATE, transaction });

    if (
      !ticket ||
      (ticket.triage_status !== TRIAGE_STATUS.PENDING &&
        ticket.triage_status !== TRIAGE_STATUS.RETRY_WAIT)
    )
      return;

    const previousStatus = ticket.triage_status;

    ticket.triage_status = TRIAGE_STATUS.PROCESSING;
    ticket.processing_attempt += 1;
    ticket.processing_started_at = new Date();
    if (previousStatus === TRIAGE_STATUS.RETRY_WAIT) ticket.last_retry_at = new Date();
    processingAttempt = ticket.processing_attempt;
    await ticket.save({ transaction });

    await TicketStatusHistory.create(
      {
        ticket_id: ticketId,
        previous_status: previousStatus,
        new_status: TRIAGE_STATUS.PROCESSING,
        reason: ticketProcessingReasonByPreviousStatus[previousStatus],
        retry_count: ticket.retry_count,
      },
      { transaction }
    );
  });

  if (processingAttempt === undefined) return false;

  const ticket = await Ticket.findByPk(ticketId);
  if (!ticket) return false;

  try {
    logger.info(`Ticket ${ticketId} triage validation started`);
    const triageResult = await cachedTriage({ subject: ticket.subject, body: ticket.body });

    await db.transaction(async (transaction) => {
      const currentTicket = await Ticket.findByPk(ticketId, {
        lock: transaction.LOCK.UPDATE,
        transaction,
      });

      if (
        !currentTicket ||
        currentTicket.processing_attempt !== processingAttempt ||
        currentTicket.triage_status !== TRIAGE_STATUS.PROCESSING
      )
        return;

      await TriageResult.findOrCreate({
        where: { ticket_id: ticketId },
        defaults: {
          ticket_id: ticketId,
          ...triageResult.result,
          model_name: MODEL_NAME,
          prompt_version: PROMPT_VERSION,
          source: triageResult.source,
        },
        transaction,
      });

      currentTicket.triage_status = TRIAGE_STATUS.TRIAGED;
      currentTicket.status_reason = TICKET_STATUS_REASON.TRIAGE_COMPLETED;
      currentTicket.completed_at = new Date();
      await currentTicket.save({ transaction });

      await TicketStatusHistory.create(
        {
          ticket_id: ticketId,
          previous_status: TRIAGE_STATUS.PROCESSING,
          new_status: TRIAGE_STATUS.TRIAGED,
          reason: TICKET_STATUS_REASON.TRIAGE_COMPLETED,
          retry_count: currentTicket.retry_count,
        },
        { transaction }
      );
    });

    logger.info(`Ticket ${ticketId} triage completed successfully`);
    await detectDuplicate({ ticket, ticketId });
    return false;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Provider failure';
    const invalidOutput = reason.startsWith('Invalid model output');
    let shouldRetry = false;

    await db.transaction(async (transaction) => {
      const currentTicket = await Ticket.findByPk(ticketId, {
        lock: transaction.LOCK.UPDATE,
        transaction,
      });

      if (
        !currentTicket ||
        currentTicket.processing_attempt !== processingAttempt ||
        currentTicket.triage_status !== TRIAGE_STATUS.PROCESSING
      )
        return;

      const canRetry = !invalidOutput && currentTicket.retry_count < 3;
      shouldRetry = canRetry;
      currentTicket.triage_status = canRetry
        ? TRIAGE_STATUS.RETRY_WAIT
        : TRIAGE_STATUS.MANUAL_REVIEW;
      currentTicket.status_reason = reason;

      if (canRetry) currentTicket.retry_count += 1;

      await currentTicket.save({ transaction });
      await TicketStatusHistory.create(
        {
          ticket_id: ticketId,
          previous_status: TRIAGE_STATUS.PROCESSING,
          new_status: currentTicket.triage_status,
          reason,
          retry_count: currentTicket.retry_count,
        },
        { transaction }
      );
    });

    logger.error(`Ticket ${ticketId} processing failed: ${reason}`);
    return shouldRetry;
  }
};

/** Store an embedding and link the closest open ticket for the same customer. */
const detectDuplicate = async ({
  ticket,
  ticketId,
}: {
  ticket: Ticket;
  ticketId: number;
}): Promise<void> => {
  try {
    const vector = await embedText({ subject: ticket.subject, body: ticket.body });

    await TicketEmbedding.findOrCreate({
      where: { ticket_id: ticketId },
      defaults: { ticket_id: ticketId, embedding_model: EMBEDDING_MODEL, embedding: vector },
    });

    const candidates = await Ticket.findAll({
      where: {
        customer_id: ticket.customer_id,
        id: { [Op.ne]: ticketId },
        triage_status: {
          [Op.in]: [
            TRIAGE_STATUS.PENDING,
            TRIAGE_STATUS.PROCESSING,
            TRIAGE_STATUS.RETRY_WAIT,
            TRIAGE_STATUS.TRIAGED,
          ],
        },
      },
      attributes: ['id'],
    });
    const candidateIds = candidates.map((candidate) => Number(candidate.id));

    if (candidateIds.length === 0) return;

    const { cosineDistance } = await import('pgvector/sequelize');
    const closest = await TicketEmbedding.findOne({
      where: { ticket_id: { [Op.in]: candidateIds }, embedding_model: EMBEDDING_MODEL },
      order: [[cosineDistance('embedding', vector, db), 'ASC']],
    });

    if (!closest) return;

    const similarity = cosineSimilarity(vector, closest.embedding);
    if (similarity >= 0.92) {
      await Ticket.update(
        { duplicate_of_ticket_id: closest.ticket_id },
        { where: { id: ticketId } }
      );
    }
  } catch (error) {
    logger.error(`Ticket ${ticketId} duplicate detection failed: ${(error as Error).message}`);
  }
};

/** Compare normalized vectors using cosine similarity. */
export const cosineSimilarity = (firstVector: number[], secondVector: number[]): number => {
  const dotProduct = firstVector.reduce(
    (sum, value, index) => sum + value * secondVector[index],
    0
  );
  const firstNorm = Math.sqrt(firstVector.reduce((sum, value) => sum + value * value, 0));
  const secondNorm = Math.sqrt(secondVector.reduce((sum, value) => sum + value * value, 0));

  if (firstNorm === 0 || secondNorm === 0) return 0;

  return dotProduct / (firstNorm * secondNorm);
};
