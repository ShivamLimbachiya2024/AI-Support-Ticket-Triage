import amqp, { ChannelModel, ConfirmChannel } from 'amqplib';
import { RABBITMQ_HOST, RABBITMQ_PASSWORD, RABBITMQ_USER } from '../config';
import { QueueName } from './enums';

let connection: ChannelModel | undefined;
let channel: ConfirmChannel | undefined;
const retryDelayMinMs = 30_000;
const retryDelayMaxMs = 120_000;

/** Connect to RabbitMQ and declare the application's durable queues. */
export const connectRabbitMq = async (): Promise<ConfirmChannel> => {
  if (channel) return channel;

  const rabbitConnection = await amqp.connect({
    hostname: RABBITMQ_HOST,
    username: RABBITMQ_USER,
    password: RABBITMQ_PASSWORD,
  });
  connection = rabbitConnection;
  const rabbitChannel = await rabbitConnection.createConfirmChannel();

  // Quorum queue delivery counts drive RabbitMQ's native delayed retry policy.
  await rabbitChannel.assertQueue(QueueName.TICKET_PROCESSING, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-delayed-retry-type': 'failed',
      'x-delayed-retry-min': retryDelayMinMs,
      'x-delayed-retry-max': retryDelayMaxMs,
    },
  });

  channel = rabbitChannel;

  return rabbitChannel;
};

/** Return an established publisher/consumer channel. */
export const getRabbitChannel = (): ConfirmChannel => {
  if (!channel) throw new Error('RabbitMQ connection has not been initialized');

  return channel;
};
