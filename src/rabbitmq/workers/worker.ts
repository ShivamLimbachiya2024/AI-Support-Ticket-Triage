import { ConsumeMessage } from 'amqplib';
import { Op } from 'sequelize';
import { logger } from '../../logger';
import db from '../../sequelize/models';
import Ticket from '../../sequelize/models/tickets.modal';
import TicketStatusHistory from '../../sequelize/models/ticket_status_history.modal';
import { TRIAGE_STATUS, TICKET_STATUS_REASON } from '../../modules/tickets/enum';
import { QueueAction, QueueName } from '../enums';
import type { QueueHandler, QueuePayload } from '../types';
import { queuePayloadSchema } from '../schemas';
import { getRabbitChannel } from '../connection';
import { processTicket } from '../handlers/ticketProcessing.handler';
import { sendToQueue } from '../publisher';

const queueHandlers: Record<QueueName, Partial<Record<QueueAction, QueueHandler>>> = {
  [QueueName.TICKET_PROCESSING]: {
    [QueueAction.PROCESS_TICKET]: ({ ticketId }) => processTicket(ticketId),
  },
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

      if (error) {
        logger.error(`Invalid message received from ${queueName}`);
        channel.reject(message, false);
        return;
      }

      const payload = value as QueuePayload;
      const handler = queueHandlers[queueName][payload.action];

      if (!handler) {
        logger.error(`Unsupported action received from ${queueName}`);
        channel.reject(message, false);
        return;
      }

      const shouldRetry = await handler(payload);

      if (shouldRetry) channel.reject(message, true);
      else channel.ack(message);
    } catch (error) {
      logger.error(`Queue ${queueName} message failed: ${(error as Error).message}`);
      channel.reject(message, true);
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
      ticket.status_reason = TICKET_STATUS_REASON.PROCESSING_TIMEOUT;
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
