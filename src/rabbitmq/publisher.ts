import { logger } from '../logger';
import { getRabbitChannel } from './connection';
import type { QueueMessage } from './types';

/** Publish one durable message directly to its target queue. */
export const sendToQueue = async (message: QueueMessage): Promise<void> => {
  const channel = getRabbitChannel();

  const payload = { action: message.action, ...message.payload };
  logger.info(
    `Publishing ${message.action} for ticket ${message.payload.ticketId} to queue ${message.queueName}`
  );

  try {
    await new Promise<void>((resolve, reject) => {
      channel.sendToQueue(
        message.queueName,
        Buffer.from(JSON.stringify(payload)),
        { persistent: true },
        (error) => (error ? reject(error) : resolve())
      );
    });
  } catch (error) {
    logger.error(
      `Publishing ${message.action} for ticket ${message.payload.ticketId} to ${message.queueName} failed: ${(error as Error).message}`
    );
    throw error;
  }

  logger.info(
    `Published ${message.action} for ticket ${message.payload.ticketId} to ${message.queueName}`
  );
};
