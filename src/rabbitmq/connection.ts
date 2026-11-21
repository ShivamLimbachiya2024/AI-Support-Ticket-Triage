import amqp, { ChannelModel, ConfirmChannel } from 'amqplib';
import { RABBITMQ_HOST, RABBITMQ_PASSWORD, RABBITMQ_USER } from '../config';
import { logger } from '../logger';
import { QueueName } from './enums';

let connection: ChannelModel | undefined;
let channel: ConfirmChannel | undefined;
const retryDelayMinMs = 30_000;
const retryDelayMaxMs = 120_000;

/** Connect to RabbitMQ and declare the application's durable queues. */
export const connectRabbitMq = async (): Promise<ConfirmChannel> => {
  if (channel) return channel;

  logger.info(`Connecting to RabbitMQ host ${RABBITMQ_HOST}`);
  const rabbitConnection = await amqp.connect({
    hostname: RABBITMQ_HOST,
    username: RABBITMQ_USER,
    password: RABBITMQ_PASSWORD,
  });
  connection = rabbitConnection;
  logger.info('RabbitMQ connection established; creating publisher confirm channel');
  const rabbitChannel = await rabbitConnection.createConfirmChannel();

  // Quorum queue delivery counts drive RabbitMQ's native delayed retry policy.
  logger.info(
    `Declaring durable quorum queue ${QueueName.TICKET_PROCESSING} with native delayed retry`
  );
  await rabbitChannel.assertQueue(QueueName.TICKET_PROCESSING, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-delayed-retry-type': 'failed',
      'x-delayed-retry-min': retryDelayMinMs,
      'x-delayed-retry-max': retryDelayMaxMs,
    },
  });
  logger.info(`Queue ${QueueName.TICKET_PROCESSING} declared with delayed retry enabled`);

  channel = rabbitChannel;
  logger.info('RabbitMQ publisher confirm channel is ready');

  return rabbitChannel;
};

/** Return an established publisher/consumer channel. */
export const getRabbitChannel = (): ConfirmChannel => {
  if (!channel) throw new Error('RabbitMQ connection has not been initialized');

  return channel;
};
