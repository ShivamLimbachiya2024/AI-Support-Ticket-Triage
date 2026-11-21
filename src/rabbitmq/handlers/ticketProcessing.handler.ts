import { Op } from 'sequelize';
import db from '../../sequelize/models';
import Ticket from '../../sequelize/models/tickets.modal';
import TriageResult from '../../sequelize/models/triage_results.modal';
import TicketStatusHistory from '../../sequelize/models/ticket_status_history.modal';
import TicketEmbedding from '../../sequelize/models/ticket_embeddings.modal';
import { EMBEDDING_MODEL, MODEL_NAME, PROMPT_VERSION } from '../../config';
import { TRIAGE_STATUS } from '../../modules/tickets/enum';
import { logger } from '../../logger';
import { QueueAction, QueueName } from '../enums';
import { sendToQueue } from '../publisher';
import { cachedTriage, embedText } from '../triage';
import { retryDelayMs } from '../../utils/retry';

/**
 * Claim and triage a ticket. The row lock is released before model inference.
 * processing_attempt fences completions from stale worker deliveries.
 */
export const processTicket = async (ticketId: number): Promise<void> => {
  let processingAttempt: number | undefined;

  await db.transaction(async (transaction) => {
    const ticket = await Ticket.findByPk(ticketId, { lock: transaction.LOCK.UPDATE, transaction });

    if (!ticket || ticket.triage_status !== TRIAGE_STATUS.PENDING) return;

    ticket.triage_status = TRIAGE_STATUS.PROCESSING;
    ticket.processing_attempt += 1;
    ticket.processing_started_at = new Date();
    processingAttempt = ticket.processing_attempt;
    await ticket.save({ transaction });

    await TicketStatusHistory.create(
      {
        ticket_id: ticketId,
        previous_status: TRIAGE_STATUS.PENDING,
        new_status: TRIAGE_STATUS.PROCESSING,
        reason: 'Processing started',
        retry_count: ticket.retry_count,
      },
      { transaction }
    );
  });

  if (processingAttempt === undefined) return;

  const ticket = await Ticket.findByPk(ticketId);
  if (!ticket) return;

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
      currentTicket.status_reason = 'Triage completed';
      currentTicket.completed_at = new Date();
      await currentTicket.save({ transaction });

      await TicketStatusHistory.create(
        {
          ticket_id: ticketId,
          previous_status: TRIAGE_STATUS.PROCESSING,
          new_status: TRIAGE_STATUS.TRIAGED,
          reason: 'Triage completed',
          retry_count: currentTicket.retry_count,
        },
        { transaction }
      );
    });

    logger.info(`Ticket ${ticketId} triage completed successfully`);
    await detectDuplicate({ ticket, ticketId });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Provider failure';
    const invalidOutput = reason.startsWith('Invalid model output');

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

      if (canRetry) {
        await sendToQueue({
          queueName: QueueName.TICKET_RETRY,
          action: QueueAction.RETRY_TICKET,
          payload: { ticketId },
          delayMs: retryDelayMs(currentTicket.retry_count),
        });
      }
    });

    logger.error(`Ticket ${ticketId} processing failed: ${reason}`);
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
