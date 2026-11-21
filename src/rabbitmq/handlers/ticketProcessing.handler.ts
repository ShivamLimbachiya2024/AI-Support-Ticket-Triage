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
import { classifyProviderError } from '../../utils/retry';
import { cachedTriage, embedText, verifySemanticReuse, SEMANTIC_REUSE_THRESHOLD } from '../triage';

/**
 * Claim and triage a ticket. The row lock is released before model inference.
 * processing_attempt fences completions from stale worker deliveries.
 */
export const processTicket = async (ticketId: number): Promise<boolean> => {
  logger.info(`Ticket ${ticketId} processing workflow started`);
  let processingAttempt: number | undefined;

  logger.info(`Ticket ${ticketId} claim transaction started`);
  await db.transaction(async (transaction) => {
    logger.info(`Ticket ${ticketId} row lock requested for processing claim`);
    const ticket = await Ticket.findByPk(ticketId, { lock: transaction.LOCK.UPDATE, transaction });

    if (!ticket) {
      logger.info(`Ticket ${ticketId} claim skipped because the ticket does not exist`);
      return;
    }

    logger.info(`Ticket ${ticketId} row locked with status ${ticket.triage_status}`);
    if (
      ticket.triage_status !== TRIAGE_STATUS.PENDING &&
      ticket.triage_status !== TRIAGE_STATUS.RETRY_WAIT
    ) {
      logger.info(
        `Ticket ${ticketId} claim skipped because status ${ticket.triage_status} is not eligible`
      );
      return;
    }
    const previousStatus = ticket.triage_status;

    logger.info(
      `Ticket ${ticketId} claim transition started: ${previousStatus} to ${TRIAGE_STATUS.PROCESSING}`
    );
    ticket.triage_status = TRIAGE_STATUS.PROCESSING;
    ticket.processing_attempt += 1;
    ticket.processing_started_at = new Date();
    if (previousStatus === TRIAGE_STATUS.RETRY_WAIT) ticket.last_retry_at = new Date();
    processingAttempt = ticket.processing_attempt;
    await ticket.save({ transaction });
    logger.info(
      `Ticket ${ticketId} status changed to ${TRIAGE_STATUS.PROCESSING} on attempt ${processingAttempt}`
    );

    logger.info(`Ticket ${ticketId} processing-started history write started`);
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
    logger.info(`Ticket ${ticketId} processing-started history recorded`);
  });
  logger.info(`Ticket ${ticketId} claim transaction completed`);

  if (processingAttempt === undefined) {
    logger.info(
      `Ticket ${ticketId} processing workflow skipped because this delivery did not claim it`
    );
    return false;
  }

  logger.info(`Ticket ${ticketId} reload before triage started for attempt ${processingAttempt}`);
  const ticket = await Ticket.findByPk(ticketId);
  if (!ticket) {
    logger.warn(`Ticket ${ticketId} disappeared after claim; no triage call will be made`);
    return false;
  }
  logger.info(
    `Ticket ${ticketId} reload completed; beginning triage for attempt ${processingAttempt}`
  );

  try {
    logger.info(`Ticket ${ticketId} triage validation started`);
    const triageResult = await cachedTriage({
      subject: ticket.subject,
      body: ticket.body,
      findSimilar: () => findSemanticTriage({ ticket, ticketId }),
    });
    logger.info(
      `Ticket ${ticketId} triage result ready: category ${triageResult.result.category}, priority ${triageResult.result.priority}, source ${triageResult.source}`
    );

    logger.info(
      `Ticket ${ticketId} completion transaction started for attempt ${processingAttempt}`
    );
    let triagePersisted = false;
    await db.transaction(async (transaction) => {
      logger.info(`Ticket ${ticketId} completion row lock requested`);
      const currentTicket = await Ticket.findByPk(ticketId, {
        lock: transaction.LOCK.UPDATE,
        transaction,
      });

      if (
        !currentTicket ||
        currentTicket.processing_attempt !== processingAttempt ||
        currentTicket.triage_status !== TRIAGE_STATUS.PROCESSING
      ) {
        logger.info(`Ticket ${ticketId} completion skipped because its attempt or status changed`);
        return;
      }

      logger.info(`Ticket ${ticketId} triage result persistence started`);
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
      logger.info(`Ticket ${ticketId} triage result persistence completed`);

      logger.info(
        `Ticket ${ticketId} status transition started: ${TRIAGE_STATUS.PROCESSING} to ${TRIAGE_STATUS.TRIAGED}`
      );
      const confident = (triageResult.result.confidence ?? 0) >= 0.85;
      currentTicket.triage_status = confident ? TRIAGE_STATUS.TRIAGED : TRIAGE_STATUS.MANUAL_REVIEW;
      currentTicket.status_reason = confident
        ? TICKET_STATUS_REASON.TRIAGE_COMPLETED
        : 'Low classification confidence';
      currentTicket.completed_at = new Date();
      await currentTicket.save({ transaction });
      logger.info(`Ticket ${ticketId} status updated to ${TRIAGE_STATUS.TRIAGED}`);

      logger.info(`Ticket ${ticketId} triage-completed history write started`);
      await TicketStatusHistory.create(
        {
          ticket_id: ticketId,
          previous_status: TRIAGE_STATUS.PROCESSING,
          new_status: currentTicket.triage_status,
          reason: currentTicket.status_reason,
          retry_count: currentTicket.retry_count,
        },
        { transaction }
      );
      logger.info(`Ticket ${ticketId} triage-completed history recorded`);
      triagePersisted = true;
    });
    logger.info(`Ticket ${ticketId} completion transaction completed`);

    if (!triagePersisted) {
      logger.warn(
        `Ticket ${ticketId} triage result was not persisted because the processing attempt became stale`
      );
      return false;
    }

    logger.info(`Ticket ${ticketId} triage completed successfully`);
    logger.info(`Ticket ${ticketId} duplicate detection started`);
    await detectDuplicate({ ticket, ticketId });
    logger.info(`Ticket ${ticketId} duplicate detection completed`);
    return false;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Provider failure';
    const invalidOutput = reason.startsWith('Invalid model output');
    const failure = invalidOutput
      ? { kind: 'invalidRequest' as const }
      : classifyProviderError({ error });
    let shouldRetry = false;

    logger.error(`Ticket ${ticketId} triage attempt failed: ${reason}`);
    logger.info(`Ticket ${ticketId} failure status transaction started`);
    await db.transaction(async (transaction) => {
      logger.info(`Ticket ${ticketId} failure row lock requested`);
      const currentTicket = await Ticket.findByPk(ticketId, {
        lock: transaction.LOCK.UPDATE,
        transaction,
      });

      if (
        !currentTicket ||
        currentTicket.processing_attempt !== processingAttempt ||
        currentTicket.triage_status !== TRIAGE_STATUS.PROCESSING
      ) {
        logger.info(
          `Ticket ${ticketId} failure update skipped because its attempt or status changed`
        );
        return;
      }

      const canRetry =
        (failure.kind === 'transient' || failure.kind === 'rateLimit') &&
        currentTicket.retry_count < 3;
      shouldRetry = canRetry;
      const previousStatus = currentTicket.triage_status;
      currentTicket.triage_status = canRetry
        ? TRIAGE_STATUS.RETRY_WAIT
        : TRIAGE_STATUS.MANUAL_REVIEW;
      currentTicket.status_reason = reason;
      if (canRetry) currentTicket.retry_count += 1;

      logger.info(
        `Ticket ${ticketId} failure transition started: ${previousStatus} to ${currentTicket.triage_status}; retry_count=${currentTicket.retry_count}`
      );
      await currentTicket.save({ transaction });
      logger.info(`Ticket ${ticketId} failure status saved as ${currentTicket.triage_status}`);

      logger.info(`Ticket ${ticketId} failure history write started`);
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
      logger.info(`Ticket ${ticketId} failure history recorded with reason: ${reason}`);
    });

    logger.info(`Ticket ${ticketId} failure status transaction completed`);
    if (shouldRetry) {
      logger.info(`Ticket ${ticketId} is retryable; requesting RabbitMQ delayed redelivery`);
    } else {
      logger.warn(
        `Ticket ${ticketId} moved to ${TRIAGE_STATUS.MANUAL_REVIEW}; no further retry will be requested`
      );
    }
    return shouldRetry;
  }
};

/** Find a same-customer, previously verified result for guarded reuse. */
export const findSemanticTriage = async ({
  ticket,
  ticketId,
}: {
  ticket: Ticket;
  ticketId: number;
}): Promise<import('../types').TriageOutput | null> => {
  const vector = await embedText({ subject: ticket.subject, body: ticket.body });
  const candidates = await Ticket.findAll({
    where: {
      customer_id: ticket.customer_id,
      id: { [Op.ne]: ticketId },
      triage_status: TRIAGE_STATUS.TRIAGED,
    },
    attributes: ['id'],
  });
  if (candidates.length === 0) return null;
  const { cosineDistance } = await import('pgvector/sequelize');
  const cosineDistanceExpression = cosineDistance('embedding', vector, db);
  const closest = await TicketEmbedding.findOne({
    where: {
      ticket_id: { [Op.in]: candidates.map((candidate) => Number(candidate.id)) },
      embedding_model: EMBEDDING_MODEL,
    },
    attributes: ['ticket_id', [cosineDistanceExpression, 'cosineDistance']],
    order: [[cosineDistanceExpression, 'ASC']],
  });
  if (!closest) return null;
  const similarity = 1 - Number(closest.get('cosineDistance'));
  if (!Number.isFinite(similarity) || similarity < SEMANTIC_REUSE_THRESHOLD) return null;
  const previous = await TriageResult.findOne({
    where: { ticket_id: closest.ticket_id, model_name: MODEL_NAME, prompt_version: PROMPT_VERSION },
  });
  if (!previous || (previous.confidence ?? 0) < 0.85) return null;
  return verifySemanticReuse({
    ticket: { subject: ticket.subject, body: ticket.body },
    category: previous.category as import('../../modules/tickets/enum').TICKET_CATEGORY,
    priority: previous.priority as import('../../modules/tickets/enum').TICKET_PRIORITY,
  });
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
    logger.info(`Ticket ${ticketId} embedding generation started for duplicate detection`);
    const vector = await embedText({ subject: ticket.subject, body: ticket.body });
    logger.info(`Ticket ${ticketId} embedding generated with ${vector.length} dimensions`);

    logger.info(`Ticket ${ticketId} embedding persistence started`);
    const [, embeddingCreated] = await TicketEmbedding.findOrCreate({
      where: { ticket_id: ticketId },
      defaults: { ticket_id: ticketId, embedding_model: EMBEDDING_MODEL, embedding: vector },
    });
    logger.info(
      `Ticket ${ticketId} embedding persistence completed: ${embeddingCreated ? 'created' : 'already existed'}`
    );

    logger.info(`Ticket ${ticketId} duplicate candidate lookup started`);
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
    logger.info(
      `Ticket ${ticketId} duplicate candidate lookup found ${candidateIds.length} ticket(s)`
    );

    if (candidateIds.length === 0) {
      logger.info(
        `Ticket ${ticketId} duplicate detection ended because no candidates were available`
      );
      return;
    }

    logger.info(`Ticket ${ticketId} nearest embedding search started`);
    const { cosineDistance } = await import('pgvector/sequelize');
    const cosineDistanceExpression = cosineDistance('embedding', vector, db);
    const closest = await TicketEmbedding.findOne({
      where: { ticket_id: { [Op.in]: candidateIds }, embedding_model: EMBEDDING_MODEL },
      attributes: ['ticket_id', [cosineDistanceExpression, 'cosineDistance']],
      order: [[cosineDistanceExpression, 'ASC']],
    });

    if (!closest) {
      logger.info(
        `Ticket ${ticketId} duplicate detection ended because no stored embeddings matched`
      );
      return;
    }

    const similarity = 1 - Number(closest.get('cosineDistance'));
    if (!Number.isFinite(similarity)) {
      logger.warn(
        `Ticket ${ticketId} duplicate detection skipped because cosine distance was invalid`
      );
      return;
    }
    logger.info(
      `Ticket ${ticketId} closest candidate is ${closest.ticket_id} with similarity ${similarity.toFixed(4)}`
    );
    if (similarity >= 0.92) {
      logger.info(
        `Ticket ${ticketId} exceeds the duplicate threshold; linking to ticket ${closest.ticket_id}`
      );
      await Ticket.update(
        { duplicate_of_ticket_id: closest.ticket_id },
        { where: { id: ticketId } }
      );
      logger.info(`Ticket ${ticketId} linked to duplicate ticket ${closest.ticket_id}`);
    } else {
      logger.info(`Ticket ${ticketId} is below the duplicate threshold and remains unlinked`);
    }
  } catch (error) {
    logger.error(`Ticket ${ticketId} duplicate detection failed: ${(error as Error).message}`);
  }
};
