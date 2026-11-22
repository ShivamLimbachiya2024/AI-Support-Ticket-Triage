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
  TICKET_TRIAGE_FAILURE_CODE,
  ticketProcessingReasonByPreviousStatus,
} from '../../modules/tickets/enum';
import { logger } from '../../logger';
import { GeminiRequestError } from '../../utils/retry';
import { GEMINI_FAILURE_KIND } from '../enums';
import {
  cachedTriage,
  embedText,
  InvalidClassificationError,
  verifySemanticReuse,
  SEMANTIC_REUSE_THRESHOLD,
} from '../triage';

const providerFailureReasons = {
  [GEMINI_FAILURE_KIND.CONNECTION]: TICKET_STATUS_REASON.GEMINI_CONNECTION_FAILED,
  [GEMINI_FAILURE_KIND.TRANSIENT]: TICKET_STATUS_REASON.GEMINI_TEMPORARILY_UNAVAILABLE,
  [GEMINI_FAILURE_KIND.RATE_LIMIT]: TICKET_STATUS_REASON.GEMINI_RATE_LIMITED,
  [GEMINI_FAILURE_KIND.PAYMENT_REQUIRED]: TICKET_STATUS_REASON.GEMINI_PAYMENT_REQUIRED,
  [GEMINI_FAILURE_KIND.CONFIGURATION]: TICKET_STATUS_REASON.GEMINI_CONFIGURATION_FAILED,
  [GEMINI_FAILURE_KIND.INVALID_REQUEST]: TICKET_STATUS_REASON.GEMINI_REQUEST_REJECTED,
  [GEMINI_FAILURE_KIND.UNCLASSIFIED]: TICKET_STATUS_REASON.CLASSIFICATION_FAILED,
};
const claimableStatuses: string[] = [TRIAGE_STATUS.PENDING, TRIAGE_STATUS.RETRY_WAIT];
const retryableFailureKinds: GEMINI_FAILURE_KIND[] = [
  GEMINI_FAILURE_KIND.CONNECTION,
  GEMINI_FAILURE_KIND.TRANSIENT,
  GEMINI_FAILURE_KIND.RATE_LIMIT,
];
const maxDelayedRetries = 3;

/**
 * Claim and triage a ticket. The row lock is released before model inference.
 * processing_attempt fences completions from stale worker deliveries.
 */
export const processTicket = async ({ ticketId }: { ticketId: number }): Promise<boolean> => {
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
    const connectionRetryScheduled =
      ticket.triage_status === TRIAGE_STATUS.MANUAL_REVIEW &&
      ticket.status_reason === TICKET_STATUS_REASON.GEMINI_CONNECTION_RETRY_SCHEDULED &&
      ticket.triage_failure_code === TICKET_TRIAGE_FAILURE_CODE.GEMINI_CONNECTION;
    const processableStatuses = [...claimableStatuses];
    if (connectionRetryScheduled) processableStatuses.push(TRIAGE_STATUS.MANUAL_REVIEW);
    if (!processableStatuses.includes(ticket.triage_status)) {
      logger.info(
        `Ticket ${ticketId} claim skipped because status ${ticket.triage_status} is not eligible`
      );
      return;
    }
    const previousStatus = ticket.triage_status as
      TRIAGE_STATUS.PENDING | TRIAGE_STATUS.RETRY_WAIT | TRIAGE_STATUS.MANUAL_REVIEW;

    logger.info(
      `Ticket ${ticketId} claim transition started: ${previousStatus} to ${TRIAGE_STATUS.PROCESSING}`
    );
    ticket.triage_status = TRIAGE_STATUS.PROCESSING;
    ticket.processing_attempt += 1;
    ticket.processing_started_at = new Date();
    const reason = ticketProcessingReasonByPreviousStatus[previousStatus];
    ticket.status_reason = reason;
    ticket.triage_failure_code = null;
    const previousStatusNeedsRetryTimestamp = previousStatus === TRIAGE_STATUS.RETRY_WAIT;
    if (previousStatusNeedsRetryTimestamp || connectionRetryScheduled) {
      ticket.last_retry_at = ticket.processing_started_at;
    }
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
        reason,
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
    logger.warn(`Ticket ${ticketId} disappeared after its processing claim`);
    return false;
  }
  const processingAttemptChanged = ticket.processing_attempt !== processingAttempt;
  if (processingAttemptChanged) {
    logger.warn(`Ticket ${ticketId} claim is stale because its processing attempt changed`);
    return false;
  }
  const ticketIsNotProcessing = ticket.triage_status !== TRIAGE_STATUS.PROCESSING;
  if (ticketIsNotProcessing) {
    logger.warn(`Ticket ${ticketId} claim is stale because its status is ${ticket.triage_status}`);
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

      if (!currentTicket) {
        logger.info(`Ticket ${ticketId} completion skipped because the ticket no longer exists`);
        return;
      }
      const completionAttemptChanged = currentTicket.processing_attempt !== processingAttempt;
      if (completionAttemptChanged) {
        logger.info(`Ticket ${ticketId} completion skipped because its processing attempt changed`);
        return;
      }
      const completionStatusChanged = currentTicket.triage_status !== TRIAGE_STATUS.PROCESSING;
      if (completionStatusChanged) {
        logger.info(
          `Ticket ${ticketId} completion skipped because its status is ${currentTicket.triage_status}`
        );
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

      const confident = (triageResult.result.confidence ?? 0) >= 0.85;
      let newStatus = TRIAGE_STATUS.MANUAL_REVIEW;
      let statusReason = TICKET_STATUS_REASON.LOW_CLASSIFICATION_CONFIDENCE;
      let failureCode: TICKET_TRIAGE_FAILURE_CODE | null =
        TICKET_TRIAGE_FAILURE_CODE.LOW_CONFIDENCE;
      if (confident) {
        newStatus = TRIAGE_STATUS.TRIAGED;
        statusReason = TICKET_STATUS_REASON.TRIAGE_COMPLETED;
        failureCode = null;
      }
      logger.info(
        `Ticket ${ticketId} status transition started: ${TRIAGE_STATUS.PROCESSING} to ${newStatus}`
      );
      currentTicket.triage_status = newStatus;
      currentTicket.status_reason = statusReason;
      currentTicket.triage_failure_code = failureCode;
      currentTicket.processing_started_at = null;
      currentTicket.completed_at = new Date();
      await currentTicket.save({ transaction });
      logger.info(`Ticket ${ticketId} status updated to ${currentTicket.triage_status}`);

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
    if (!(error instanceof GeminiRequestError) && !(error instanceof InvalidClassificationError)) {
      logger.error(
        `Ticket ${ticketId} attempt ${processingAttempt} was interrupted by an application error`
      );
      throw error;
    }
    const invalidOutput = error instanceof InvalidClassificationError;
    let kind = GEMINI_FAILURE_KIND.UNCLASSIFIED;
    if (error instanceof GeminiRequestError) kind = error.kind;
    let reason = providerFailureReasons[kind];
    if (invalidOutput) reason = TICKET_STATUS_REASON.INVALID_CLASSIFICATION;
    let failureCode: TICKET_TRIAGE_FAILURE_CODE | null = null;
    if (invalidOutput) failureCode = TICKET_TRIAGE_FAILURE_CODE.INVALID_CLASSIFICATION;
    const connectionFailure = kind === GEMINI_FAILURE_KIND.CONNECTION;
    if (connectionFailure) failureCode = TICKET_TRIAGE_FAILURE_CODE.GEMINI_CONNECTION;
    let shouldRetry = false;
    let failurePersisted = false;

    logger.error(`Ticket ${ticketId} triage attempt failed: ${reason}; failure_kind=${kind}`);
    logger.info(`Ticket ${ticketId} failure status transaction started`);
    await db.transaction(async (transaction) => {
      logger.info(`Ticket ${ticketId} failure row lock requested`);
      const currentTicket = await Ticket.findByPk(ticketId, {
        lock: transaction.LOCK.UPDATE,
        transaction,
      });

      if (!currentTicket) {
        logger.info(
          `Ticket ${ticketId} failure update skipped because the ticket no longer exists`
        );
        return;
      }
      const failureAttemptChanged = currentTicket.processing_attempt !== processingAttempt;
      if (failureAttemptChanged) {
        logger.info(`Ticket ${ticketId} failure update skipped because its attempt changed`);
        return;
      }
      const failureStatusChanged = currentTicket.triage_status !== TRIAGE_STATUS.PROCESSING;
      if (failureStatusChanged) {
        logger.info(
          `Ticket ${ticketId} failure update skipped because its status is ${currentTicket.triage_status}`
        );
        return;
      }

      const failureKindCanRetry = retryableFailureKinds.includes(kind);
      const retryBudgetAvailable = currentTicket.retry_count < maxDelayedRetries;
      const canRetry = failureKindCanRetry && retryBudgetAvailable;
      const scheduledConnectionRetry = canRetry && connectionFailure;
      shouldRetry = canRetry;
      const previousStatus = currentTicket.triage_status;
      if (scheduledConnectionRetry) {
        currentTicket.triage_status = TRIAGE_STATUS.MANUAL_REVIEW;
        currentTicket.status_reason = TICKET_STATUS_REASON.GEMINI_CONNECTION_RETRY_SCHEDULED;
        currentTicket.completed_at = null;
      } else if (canRetry) {
        currentTicket.triage_status = TRIAGE_STATUS.RETRY_WAIT;
        currentTicket.status_reason = reason;
        currentTicket.completed_at = null;
      } else {
        currentTicket.triage_status = TRIAGE_STATUS.MANUAL_REVIEW;
        currentTicket.status_reason = reason;
        currentTicket.completed_at = new Date();
      }
      currentTicket.triage_failure_code = failureCode;
      currentTicket.processing_started_at = null;
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
          reason: currentTicket.status_reason,
          retry_count: currentTicket.retry_count,
        },
        { transaction }
      );
      logger.info(
        `Ticket ${ticketId} failure history recorded with reason: ${currentTicket.status_reason}`
      );
      failurePersisted = true;
    });

    logger.info(`Ticket ${ticketId} failure status transaction completed`);
    if (!failurePersisted) {
      logger.warn(
        `Ticket ${ticketId} failure status was not changed because its processing attempt became stale`
      );
      return false;
    }
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
  const similarityIsInvalid = !Number.isFinite(similarity);
  if (similarityIsInvalid) return null;
  const similarityIsBelowThreshold = similarity < SEMANTIC_REUSE_THRESHOLD;
  if (similarityIsBelowThreshold) return null;
  const previous = await TriageResult.findOne({
    where: { ticket_id: closest.ticket_id, model_name: MODEL_NAME, prompt_version: PROMPT_VERSION },
  });
  if (!previous) return null;
  const previousConfidenceIsLow = (previous.confidence ?? 0) < 0.85;
  if (previousConfidenceIsLow) return null;
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
    let embeddingPersistenceOutcome = 'already existed';
    if (embeddingCreated) embeddingPersistenceOutcome = 'created';
    logger.info(
      `Ticket ${ticketId} embedding persistence completed: ${embeddingPersistenceOutcome}`
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
