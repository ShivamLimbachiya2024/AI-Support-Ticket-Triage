import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { logger } from '../../logger';
import { recoverStaleTickets } from '../../modules/tickets/helper/staleTicketRecovery.helper';
import { staleTicketRecoveryIntervalMs } from '../processingTiming';
import { QueueAction, QueueName } from '../enums';
import type { QueueHandler, QueuePayload } from '../types';
import { queuePayloadSchema } from '../schemas';
import { processTicket } from '../handlers/ticketProcessing.handler';

const queueHandlers: Record<QueueName, Partial<Record<QueueAction, QueueHandler>>> = {
  [QueueName.TICKET_PROCESSING]: {
    [QueueAction.PROCESS_TICKET]: processTicket,
  },
};

/** Consume messages from one configured queue and dispatch only its handlers. */
export const startQueueWorker = async ({
  queueName,
  channel,
}: {
  queueName: QueueName;
  channel: ConfirmChannel;
}): Promise<() => Promise<void>> => {
  let stopping = false;
  let activeMessages = 0;
  let resolveIdle: (() => void) | undefined;
  let activeRecovery: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let recoveryTimer: NodeJS.Timeout | undefined;

  logger.info(`Setting consumer prefetch to 1 for queue ${queueName}`);
  await channel.prefetch(1);
  logger.info(`Consumer prefetch is ready for queue ${queueName}`);

  logger.info(`Registering consumer for queue ${queueName}`);
  const { consumerTag } = await channel.consume(
    queueName,
    async (message: ConsumeMessage | null) => {
      if (!message) {
        logger.warn(`RabbitMQ cancelled the consumer for queue ${queueName}`);
        if (!stopping) void channel.close().catch(() => undefined);
        return;
      }

      activeMessages += 1;
      logger.info(`Message received from ${queueName}; redelivered=${message.fields.redelivered}`);

      try {
        let messageBody: unknown;
        try {
          messageBody = JSON.parse(message.content.toString());
        } catch {
          logger.error(`Message from ${queueName} discarded because it was not valid JSON`);
          channel.ack(message);
          logger.info(`Invalid JSON message from ${queueName} discarded`);
          return;
        }

        const { error, value } = queuePayloadSchema.validate(messageBody);

        if (error) {
          logger.error(
            `Message from ${queueName} discarded because its payload did not match the queue schema`
          );
          channel.ack(message);
          logger.info(`Invalid message from ${queueName} discarded`);
          return;
        }

        const payload = value as QueuePayload;
        const handler = queueHandlers[queueName][payload.action];

        if (!handler) {
          logger.error(
            `Ticket ${payload.ticketId} message discarded because action ${payload.action} is not handled by ${queueName}`
          );
          channel.ack(message);
          logger.info(`Unsupported action message for ticket ${payload.ticketId} discarded`);
          return;
        }

        logger.info(
          `Dispatching ${payload.action} for ticket ${payload.ticketId} from ${queueName}`
        );
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
        let errorName = 'an unknown error';
        if (error instanceof Error) errorName = error.name;
        logger.error(`Message processing from ${queueName} failed with ${errorName}`);
        logger.info(`Returning failed ${queueName} message to RabbitMQ for delayed redelivery`);
        try {
          channel.reject(message, true);
          logger.info(`Failed ${queueName} message returned to RabbitMQ`);
        } catch {
          logger.warn(
            `RabbitMQ channel closed before the failed ${queueName} message could be settled`
          );
        }
      } finally {
        activeMessages -= 1;
        const workerIsIdleDuringShutdown = stopping && activeMessages === 0;
        if (workerIsIdleDuringShutdown) {
          const resolve = resolveIdle;
          resolveIdle = undefined;
          resolve?.();
        }
      }
    }
  );
  logger.info(`Consumer registered successfully for queue ${queueName}`);
  if (queueName === QueueName.TICKET_PROCESSING) {
    logger.info(`Scheduling stale ticket recovery for ${queueName}`);
    const recover = (): Promise<void> => {
      if (activeRecovery) return activeRecovery;
      activeRecovery = recoverStaleTickets()
        .catch(() => logger.error('Stale ticket recovery scan failed'))
        .finally(() => {
          activeRecovery = undefined;
        });
      return activeRecovery;
    };
    recoveryTimer = setInterval(() => void recover(), staleTicketRecoveryIntervalMs);
    void recover();
  }

  channel.once('close', () => {
    if (recoveryTimer) clearInterval(recoveryTimer);
  });

  return () => {
    if (stopPromise) return stopPromise;
    stopping = true;
    if (recoveryTimer) clearInterval(recoveryTimer);
    stopPromise = (async () => {
      try {
        await channel.cancel(consumerTag);
      } catch {
        logger.warn(`RabbitMQ consumer for ${queueName} was already closed`);
      }

      if (activeMessages > 0) {
        await new Promise<void>((resolve) => {
          resolveIdle = resolve;
        });
      }
      await activeRecovery;
      logger.info(`Consumer for ${queueName} stopped after active work drained`);
    })();
    return stopPromise;
  };
};
