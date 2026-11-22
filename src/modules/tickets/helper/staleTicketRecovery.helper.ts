import { Op } from 'sequelize';
import { logger } from '../../../logger';
import db from '../../../sequelize/models';
import Ticket from '../../../sequelize/models/tickets.modal';
import TicketProcessingOutbox from '../../../sequelize/models/ticket_processing_outbox.modal';
import TicketStatusHistory from '../../../sequelize/models/ticket_status_history.modal';
import { TRIAGE_STATUS, TICKET_STATUS_REASON } from '../enum';

const staleTicketTimeoutMs = 30 * 60 * 1000;

/** Requeue processing tickets abandoned by a crashed worker. */
export const recoverStaleTickets = async (): Promise<void> => {
  const staleBefore = new Date(Date.now() - staleTicketTimeoutMs);
  logger.debug('Stale ticket recovery scan started');
  const staleTickets = await Ticket.findAll({
    where: {
      triage_status: TRIAGE_STATUS.PROCESSING,
      processing_started_at: { [Op.lt]: staleBefore },
    },
    attributes: ['id'],
  });

  if (staleTickets.length === 0) {
    logger.debug('Stale ticket recovery scan completed with no stale tickets');
    return;
  }

  logger.info(`Stale ticket recovery found ${staleTickets.length} ticket(s)`);

  for (const staleTicket of staleTickets) {
    const ticketId = Number(staleTicket.id);
    logger.info(`Stale recovery transaction started for ticket ${ticketId}`);
    await db
      .transaction(async (transaction) => {
        const ticket = await Ticket.findByPk(ticketId, {
          lock: transaction.LOCK.UPDATE,
          transaction,
        });

        if (!ticket) {
          logger.info(`Stale recovery skipped ticket ${ticketId} because it no longer exists`);
          return;
        }

        if (
          ticket.triage_status !== TRIAGE_STATUS.PROCESSING ||
          !ticket.processing_started_at ||
          ticket.processing_started_at >= staleBefore
        ) {
          logger.info(
            `Stale recovery skipped ticket ${ticketId} because its processing state changed`
          );
          return;
        }

        logger.info(
          `Stale ticket ${ticketId} transition started: ${TRIAGE_STATUS.PROCESSING} to ${TRIAGE_STATUS.PENDING}`
        );
        ticket.triage_status = TRIAGE_STATUS.PENDING;
        ticket.status_reason = TICKET_STATUS_REASON.PROCESSING_TIMEOUT;
        ticket.processing_started_at = null;
        await ticket.save({ transaction });
        logger.info(`Stale ticket ${ticketId} status updated to ${TRIAGE_STATUS.PENDING}`);

        logger.info(`Recording stale recovery status history for ticket ${ticketId}`);
        await TicketStatusHistory.create(
          {
            ticket_id: Number(ticket.id),
            previous_status: TRIAGE_STATUS.PROCESSING,
            new_status: TRIAGE_STATUS.PENDING,
            reason: ticket.status_reason,
            retry_count: ticket.retry_count,
          },
          { transaction }
        );
        logger.info(`Stale recovery status history recorded for ticket ${ticketId}`);

        logger.info(`Recording a processing event for recovered ticket ${ticketId}`);
        await TicketProcessingOutbox.create({ ticket_id: ticketId }, { transaction });
      })
      .then(
        () => logger.info(`Stale recovery transaction committed for ticket ${ticketId}`),
        () => logger.error(`Stale recovery transaction failed for ticket ${ticketId}`)
      );
  }

  logger.info(`Stale ticket recovery completed for ${staleTickets.length} ticket(s)`);
};
