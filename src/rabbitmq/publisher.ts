import { getRabbitChannel } from './connection';
import type { QueueMessage } from './types';

/** Publish one durable message directly to its target queue. */
export const sendToQueue = async (message: QueueMessage): Promise<void> => {
  const channel = getRabbitChannel();

  const payload = { action: message.action, ...message.payload };

  await new Promise<void>((resolve, reject) => {
    channel.sendToQueue(
      message.queueName,
      Buffer.from(JSON.stringify(payload)),
      { persistent: true },
      (error) => (error ? reject(error) : resolve())
    );
  });
};
