import db from '../../../sequelize/models';
import Ticket from '../../../sequelize/models/tickets.modal';
import TicketStatusHistory from '../../../sequelize/models/ticket_status_history.modal';
import TicketProcessingOutbox from '../../../sequelize/models/ticket_processing_outbox.modal';
import { logger } from '../../../logger';
import { probeGeminiConnection } from '../../../rabbitmq/triage';
import { TRIAGE_STATUS, TICKET_STATUS_REASON, TICKET_TRIAGE_FAILURE_CODE } from '../enum';

export type ClassificationRetryResult =
  | { kind: 'accepted' }
  | { kind: 'notFound' }
  | { kind: 'notEligible' }
  | { kind: 'geminiUnavailable' };

type RetryTransactionResult = 'accepted' | 'notFound' | 'notEligible';
interface RetryClassificationInput {
  requestId: string;
  ticketId: number;
  actorUserId: number;
}

export const canRetryClassification = (
  ticket: Pick<Ticket, 'triage_status' | 'status_reason' | 'triage_failure_code'>
): boolean =>
  ticket.triage_status === TRIAGE_STATUS.MANUAL_REVIEW &&
  ticket.status_reason === TICKET_STATUS_REASON.GEMINI_CONNECTION_FAILED &&
  ticket.triage_failure_code === TICKET_TRIAGE_FAILURE_CODE.GEMINI_CONNECTION;

const persistClassificationRetry = async ({
  requestId,
  ticketId,
  actorUserId,
}: RetryClassificationInput): Promise<RetryTransactionResult> => {
  logger.info(`Request ${requestId} retry status transaction started for ticket ${ticketId}`);
  return db.transaction(async (transaction): Promise<RetryTransactionResult> => {
    logger.info(`Request ${requestId} retry row lock requested for ticket ${ticketId}`);
    const currentTicket = await Ticket.findByPk(ticketId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!currentTicket) {
      logger.info(
        `Request ${requestId} retry stopped because ticket ${ticketId} was deleted before the locked recheck`
      );
      return 'notFound';
    }
    logger.info(
      `Request ${requestId} locked ticket ${ticketId} with status ${currentTicket.triage_status}`
    );
    if (!canRetryClassification(currentTicket)) {
      logger.info(
        `Request ${requestId} retry stopped because ticket ${ticketId} is no longer eligible: status=${currentTicket.triage_status}, failure_code=${currentTicket.triage_failure_code ?? 'none'}`
      );
      return 'notEligible';
    }

    logger.info(`Request ${requestId} ticket ${ticketId} retry status update started`);
    currentTicket.triage_status = TRIAGE_STATUS.PENDING;
    currentTicket.triage_failure_code = null;
    currentTicket.status_reason = TICKET_STATUS_REASON.CLASSIFICATION_RETRY_REQUESTED;
    currentTicket.processing_started_at = null;
    currentTicket.completed_at = null;
    await currentTicket.save({ transaction });
    logger.info(`Request ${requestId} ticket ${ticketId} status updated to pending`);

    logger.info(`Request ${requestId} retry status history write started for ticket ${ticketId}`);
    await TicketStatusHistory.create(
      {
        ticket_id: ticketId,
        previous_status: TRIAGE_STATUS.MANUAL_REVIEW,
        new_status: TRIAGE_STATUS.PENDING,
        reason: TICKET_STATUS_REASON.CLASSIFICATION_RETRY_REQUESTED,
        actor_user_id: actorUserId,
        retry_count: currentTicket.retry_count,
      },
      { transaction }
    );
    logger.info(`Request ${requestId} retry status history recorded for ticket ${ticketId}`);

    logger.info(
      `Request ${requestId} recording the classification retry event for ticket ${ticketId}`
    );
    await TicketProcessingOutbox.create({ ticket_id: ticketId }, { transaction });
    logger.info(`Request ${requestId} classification retry event recorded for ticket ${ticketId}`);
    return 'accepted';
  });
};

export const retryTicketClassification = async ({
  requestId,
  ticketId,
  actorUserId,
}: RetryClassificationInput): Promise<ClassificationRetryResult> => {
  logger.info(`Request ${requestId} classification retry requested for ticket ${ticketId}`);
  logger.info(`Request ${requestId} retry eligibility lookup started for ticket ${ticketId}`);
  const ticket = await Ticket.findByPk(ticketId, {
    attributes: ['triage_status', 'status_reason', 'triage_failure_code'],
  });
  if (!ticket) {
    logger.info(`Request ${requestId} retry ticket ${ticketId} was not found`);
    return { kind: 'notFound' };
  }
  logger.info(
    `Request ${requestId} retry eligibility lookup completed for ticket ${ticketId}: status=${ticket.triage_status}, failure_code=${ticket.triage_failure_code ?? 'none'}`
  );
  if (!canRetryClassification(ticket)) {
    logger.info(
      `Request ${requestId} ticket ${ticketId} is ineligible for classification retry: status=${ticket.triage_status}, failure_code=${ticket.triage_failure_code ?? 'none'}`
    );
    return { kind: 'notEligible' };
  }

  logger.info(`Request ${requestId} Gemini availability check started for ticket ${ticketId}`);
  const geminiAvailable = await probeGeminiConnection();
  if (!geminiAvailable) {
    logger.warn(
      `Request ${requestId} retry deferred because Gemini could not be verified for ticket ${ticketId}`
    );
    return { kind: 'geminiUnavailable' };
  }
  logger.info(`Request ${requestId} Gemini availability check succeeded for ticket ${ticketId}`);

  let outcome: RetryTransactionResult;
  try {
    outcome = await persistClassificationRetry({ requestId, ticketId, actorUserId });
    logger.info(
      `Request ${requestId} retry status transaction committed for ticket ${ticketId} with outcome ${outcome}`
    );
  } catch (error) {
    let errorName = 'an unknown error';
    if (error instanceof Error) errorName = error.name;
    logger.error(
      `Request ${requestId} classification retry transaction failed for ticket ${ticketId} with ${errorName}`
    );
    throw error;
  }

  if (outcome === 'notFound') {
    logger.info(`Request ${requestId} classification retry ended with 404 for ticket ${ticketId}`);
    return { kind: 'notFound' };
  }
  if (outcome === 'notEligible') {
    logger.info(`Request ${requestId} classification retry ended with 409 for ticket ${ticketId}`);
    return { kind: 'notEligible' };
  }

  logger.info(`Request ${requestId} classification retry accepted for ticket ${ticketId}`);
  return { kind: 'accepted' };
};
