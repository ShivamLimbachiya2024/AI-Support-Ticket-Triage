import db from '../../sequelize/models';
import Ticket from '../../sequelize/models/tickets.modal';
import TicketStatusHistory from '../../sequelize/models/ticket_status_history.modal';
import { TRIAGE_STATUS } from '../../modules/tickets/enum';
import { QueueAction, QueueName } from '../enums';
import { sendToQueue } from '../publisher';
import { waitUntil } from '../../utils/retry';

/** Move an eligible retry back to processing and publish it immediately. */
export const retryTicket = async (message: {
  ticketId: number;
  availableAt?: number;
}): Promise<void> => {
  await waitUntil(message.availableAt);
  const { ticketId } = message;

  await db.transaction(async (transaction) => {
    const ticket = await Ticket.findByPk(ticketId, { lock: transaction.LOCK.UPDATE, transaction });

    if (!ticket || ticket.triage_status !== TRIAGE_STATUS.RETRY_WAIT) return;

    const previousStatus = ticket.triage_status;
    ticket.triage_status = TRIAGE_STATUS.PENDING;
    ticket.last_retry_at = new Date();
    await ticket.save({ transaction });

    await TicketStatusHistory.create(
      {
        ticket_id: ticketId,
        previous_status: previousStatus,
        new_status: TRIAGE_STATUS.PENDING,
        reason: 'Retry ready',
        retry_count: ticket.retry_count,
      },
      { transaction }
    );

    await sendToQueue({
      queueName: QueueName.TICKET_PROCESSING,
      action: QueueAction.PROCESS_TICKET,
      payload: { ticketId },
    });
  });
};
