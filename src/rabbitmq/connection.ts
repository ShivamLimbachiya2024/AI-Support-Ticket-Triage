import amqp, { ConfirmChannel } from 'amqplib';
import { RABBITMQ_HOST, RABBITMQ_PASSWORD, RABBITMQ_USER } from '../config';
import { logger } from '../logger';
import { QueueName } from './enums';

let connecting: Promise<ConfirmChannel> | undefined;
const retryDelayMinMs = 30_000;
const retryDelayMaxMs = 120_000;

const openRabbitMq = async (): Promise<ConfirmChannel> => {
  logger.info(`Connecting to RabbitMQ host ${RABBITMQ_HOST}`);
  const connection = await amqp.connect(
    {
      hostname: RABBITMQ_HOST,
      username: RABBITMQ_USER,
      password: RABBITMQ_PASSWORD,
      heartbeat: 15,
    },
    { timeout: 5000 }
  );
  const activeConnection = connecting;
  const invalidate = () => {
    if (connecting === activeConnection) connecting = undefined;
  };
  connection.on('error', () => logger.warn('RabbitMQ connection reported an error'));
  connection.once('close', () => {
    invalidate();
    logger.warn('RabbitMQ connection closed');
  });

  try {
    const channel = await connection.createConfirmChannel();
    channel.on('error', () => logger.warn('RabbitMQ confirm channel reported an error'));
    channel.once('close', () => {
      invalidate();
      void connection.close().catch(() => undefined);
    });

    await channel.assertQueue(QueueName.TICKET_PROCESSING, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-delayed-retry-type': 'failed',
        'x-delayed-retry-min': retryDelayMinMs,
        'x-delayed-retry-max': retryDelayMaxMs,
      },
    });
    logger.info(`RabbitMQ queue ${QueueName.TICKET_PROCESSING} and confirm channel are ready`);
    return channel;
  } catch (error) {
    void connection.close().catch(() => undefined);
    throw error;
  }
};

/** Reuse an active connection and let later callers reconnect after a failure. */
export const connectRabbitMq = (): Promise<ConfirmChannel> => {
  if (!connecting) {
    const attempt = openRabbitMq().catch((error: unknown) => {
      if (connecting === attempt) connecting = undefined;
      throw error;
    });
    connecting = attempt;
  }
  return connecting;
};
