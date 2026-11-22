import { randomUUID } from 'crypto';
import type { ConfirmChannel } from 'amqplib';
import { logger } from '../logger';
import { connectRabbitMq } from './connection';
import type { QueueMessage } from './types';

const pendingReturns = new WeakMap<ConfirmChannel, Map<string, (error: Error) => void>>();
const confirmTimeoutMs = 10_000;

/** Confirm that RabbitMQ durably accepted and routed the message. */
export const sendToQueue = async (message: QueueMessage): Promise<void> => {
  const payload = { action: message.action, ...message.payload };
  logger.info(
    `Publishing ${message.action} for ticket ${payload.ticketId} to queue ${message.queueName}`
  );

  try {
    const channel = await connectRabbitMq();
    let returns = pendingReturns.get(channel);
    if (!returns) {
      const handlers = new Map<string, (error: Error) => void>();
      channel.on('return', (returned) => {
        handlers.get(returned.properties.messageId)?.(
          new Error('RabbitMQ returned an unroutable message')
        );
      });
      pendingReturns.set(channel, handlers);
      returns = handlers;
    }
    const handlers = returns;
    const messageId = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        handlers.delete(messageId);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(
        () => finish(new Error('RabbitMQ publish confirmation timed out')),
        confirmTimeoutMs
      );
      handlers.set(messageId, finish);
      try {
        channel.sendToQueue(
          message.queueName,
          Buffer.from(JSON.stringify(payload)),
          { persistent: true, mandatory: true, messageId },
          finish
        );
      } catch (error) {
        finish(error as Error);
      }
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'an unknown error';
    logger.warn(
      `Publishing ${message.action} for ticket ${payload.ticketId} to ${message.queueName} failed: ${reason}`
    );
    throw error;
  }

  logger.info(
    `RabbitMQ confirmed ${message.action} for ticket ${payload.ticketId} on ${message.queueName}`
  );
};
