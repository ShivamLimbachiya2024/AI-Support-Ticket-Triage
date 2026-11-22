import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';
import { RABBITMQ_HOST, RABBITMQ_PASSWORD, RABBITMQ_USER } from '../config';
import { logger } from '../logger';
import { QueueName } from './enums';

let connecting: Promise<ConfirmChannel> | undefined;
let activeConnection: ChannelModel | undefined;
let activeChannel: ConfirmChannel | undefined;
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
  const activeAttempt = connecting;
  let channel: ConfirmChannel | undefined;
  const invalidate = () => {
    if (connecting === activeAttempt) connecting = undefined;
    if (channel && activeChannel === channel) {
      activeChannel = undefined;
      activeConnection = undefined;
    }
  };
  connection.on('error', () => logger.warn('RabbitMQ connection reported an error'));
  connection.once('close', () => {
    invalidate();
    logger.warn('RabbitMQ connection closed');
  });

  try {
    channel = await connection.createConfirmChannel();
    channel.on('error', () => logger.warn('RabbitMQ confirm channel reported an error'));
    channel.once('close', () => {
      invalidate();
      void connection.close().catch(() => undefined);
    });
    activeConnection = connection;
    activeChannel = channel;

    await channel.assertQueue(QueueName.TICKET_PROCESSING, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-delayed-retry-type': 'failed',
        'x-delayed-retry-min': retryDelayMinMs,
        'x-delayed-retry-max': retryDelayMaxMs,
      },
    });
    if (connecting !== activeAttempt) {
      throw new Error('RabbitMQ connection closed during startup');
    }
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

/** Close the RabbitMQ connection during application shutdown. */
export const closeRabbitMq = async (): Promise<void> => {
  const pendingConnection = connecting;
  if (pendingConnection) await pendingConnection.catch(() => undefined);

  const connection = activeConnection;
  const channel = activeChannel;
  activeConnection = undefined;
  activeChannel = undefined;
  connecting = undefined;

  if (connection) {
    await connection.close().catch(() => undefined);
  } else if (channel) {
    await channel.close().catch(() => undefined);
  }
};
