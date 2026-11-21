import { ConsumeMessage } from 'amqplib';
import { Op } from 'sequelize';
import { logger } from '../../logger';
import db from '../../sequelize/models';
import Ticket from '../../sequelize/models/tickets.modal';
import TicketStatusHistory from '../../sequelize/models/ticket_status_history.modal';
import { TRIAGE_STATUS } from '../../modules/tickets/enum';
import { QueueAction, QueueName } from '../enums';
import type { QueueHandler, QueuePayload } from '../types';
import { queuePayloadSchema } from '../schemas';
import { getRabbitChannel } from '../connection';
import { processTicket } from '../handlers/ticketProcessing.handler';
import { retryTicket } from '../handlers/ticketRetry.handler';
import { sendToQueue } from '../publisher';

const queueHandlers: Record<QueueName, Partial<Record<QueueAction, QueueHandler>>> = {
  [QueueName.TICKET_PROCESSING]: {
    [QueueAction.PROCESS_TICKET]: ({ ticketId }) => processTicket(ticketId),
  },
  [QueueName.TICKET_RETRY]: { [QueueAction.RETRY_TICKET]: retryTicket },
};

/** Consume messages from one configured queue and dispatch only its handlers. */
export const startQueueWorker = async (queueName: QueueName): Promise<void> => {
  const channel = getRabbitChannel();
  await channel.prefetch(1);

  if (queueName === QueueName.TICKET_PROCESSING) {
    setInterval(() => {
      recoverStaleTickets().catch((error) =>
        logger.error('Stale ticket recovery failed: ' + error.message)
      );
    }, 10000);
  }

  await channel.consume(queueName, async (message: ConsumeMessage | null) => {
    if (!message) return;

    try {
      const { error, value } = queuePayloadSchema.validate(JSON.parse(message.content.toString()));
      const payload = value as QueuePayload;
      const handler = queueHandlers[queueName][payload.action];

      if (error || !handler) {
        logger.error(`Invalid message received from ${queueName}`);
        channel.nack(message, false, false);
        return;
      }

      await handler(payload);
      channel.ack(message);
    } catch (error) {
      logger.error(`Queue ${queueName} message failed: ${(error as Error).message}`);
      channel.nack(message, false, true);
    }
  });
};

/** Requeue processing tickets abandoned by a crashed worker. */
const recoverStaleTickets = async (): Promise<void> => {
  const staleBefore = new Date(Date.now() - 180000);
  const staleTickets = await Ticket.findAll({
    where: {
      triage_status: TRIAGE_STATUS.PROCESSING,
      processing_started_at: { [Op.lt]: staleBefore },
    },
    attributes: ['id'],
  });

  for (const staleTicket of staleTickets) {
    await db.transaction(async (transaction) => {
      const ticket = await Ticket.findByPk(staleTicket.id, {
        lock: transaction.LOCK.UPDATE,
        transaction,
      });

      if (
        !ticket ||
        ticket.triage_status !== TRIAGE_STATUS.PROCESSING ||
        !ticket.processing_started_at ||
        ticket.processing_started_at >= staleBefore
      )
        return;

      ticket.triage_status = TRIAGE_STATUS.PENDING;
      ticket.status_reason = 'Previous processing attempt timed out';
      await ticket.save({ transaction });

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

      await sendToQueue({
        queueName: QueueName.TICKET_PROCESSING,
        action: QueueAction.PROCESS_TICKET,
        payload: { ticketId: Number(ticket.id) },
      });
    });
  }
};
