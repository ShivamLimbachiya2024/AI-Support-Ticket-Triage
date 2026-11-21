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

const staleTicketRecoveryIntervalMs = 10 * 60 * 1000;
const staleTicketTimeoutMs = 30 * 60 * 1000;

const queueHandlers: Record<QueueName, Partial<Record<QueueAction, QueueHandler>>> = {
  [QueueName.TICKET_PROCESSING]: {
    [QueueAction.PROCESS_TICKET]: ({ ticketId }) => processTicket(ticketId),
  },
};

/** Consume messages from one configured queue and dispatch only its handlers. */
export const startQueueWorker = async (queueName: QueueName): Promise<void> => {
  const channel = getRabbitChannel();
  logger.info(`Setting consumer prefetch to 1 for queue ${queueName}`);
  await channel.prefetch(1);
  logger.info(`Consumer prefetch is ready for queue ${queueName}`);

  if (queueName === QueueName.TICKET_PROCESSING) {
    logger.info(`Scheduling stale ticket recovery every 10 minutes for queue ${queueName}`);
    recoverStaleTickets().catch((error) =>
      logger.error('Stale ticket recovery failed: ' + error.message)
    );
    setInterval(() => {
      recoverStaleTickets().catch((error) =>
        logger.error('Stale ticket recovery failed: ' + error.message)
      );
    }, staleTicketRecoveryIntervalMs);
  }

  logger.info(`Registering consumer for queue ${queueName}`);
  await channel.consume(queueName, async (message: ConsumeMessage | null) => {
    if (!message) {
      logger.warn(`RabbitMQ cancelled the consumer for queue ${queueName}`);
      return;
    }

    logger.info(`Message received from ${queueName}; redelivered=${message.fields.redelivered}`);

    try {
      const { error, value } = queuePayloadSchema.validate(JSON.parse(message.content.toString()));

      if (error) {
        logger.error(
          `Message from ${queueName} rejected because its payload did not match the queue schema`
        );
        channel.reject(message, false);
        logger.info(`Invalid message from ${queueName} rejected without requeue`);
        return;
      }

      const payload = value as QueuePayload;
      const handler = queueHandlers[queueName][payload.action];

      if (!handler) {
        logger.error(
          `Ticket ${payload.ticketId} message rejected because action ${payload.action} is not handled by ${queueName}`
        );
        channel.reject(message, false);
        logger.info(
          `Unsupported action message for ticket ${payload.ticketId} rejected without requeue`
        );
        return;
      }

      logger.info(`Dispatching ${payload.action} for ticket ${payload.ticketId} from ${queueName}`);
      const shouldRetry = await handler(payload);
      logger.info(
        `Handler completed for ticket ${payload.ticketId}; delayed retry requested=${shouldRetry}`
      );

      if (shouldRetry) {
        logger.info(
          `Returning ticket ${payload.ticketId} to ${queueName} for RabbitMQ delayed retry`
        );
        channel.reject(message, true);
        logger.info(`Ticket ${payload.ticketId} returned to RabbitMQ for delayed redelivery`);
      } else {
        logger.info(`Acknowledging completed message for ticket ${payload.ticketId}`);
        channel.ack(message);
        logger.info(`Message for ticket ${payload.ticketId} acknowledged`);
      }
    } catch (error) {
      logger.error(`Message processing from ${queueName} failed: ${(error as Error).message}`);
      logger.info(`Returning failed ${queueName} message to RabbitMQ for delayed redelivery`);
      channel.reject(message, true);
      logger.info(`Failed ${queueName} message returned to RabbitMQ`);
    }
  });
  logger.info(`Consumer registered successfully for queue ${queueName}`);
};

/** Requeue processing tickets abandoned by a crashed worker. */
const recoverStaleTickets = async (): Promise<void> => {
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
    await db.transaction(async (transaction) => {
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

      logger.info(`Republishing ticket ${ticketId} to ${QueueName.TICKET_PROCESSING}`);
      await sendToQueue({
        queueName: QueueName.TICKET_PROCESSING,
        action: QueueAction.PROCESS_TICKET,
        payload: { ticketId: Number(ticket.id) },
      });
    });
    logger.info(`Stale recovery transaction committed for ticket ${ticketId}`);
  }

  logger.info(`Stale ticket recovery completed for ${staleTickets.length} ticket(s)`);
};
