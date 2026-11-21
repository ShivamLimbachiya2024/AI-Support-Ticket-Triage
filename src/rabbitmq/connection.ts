import amqp, { ChannelModel, ConfirmChannel } from 'amqplib';
import { RABBITMQ_HOST, RABBITMQ_PASSWORD, RABBITMQ_USER } from '../config';
import { QueueName } from './enums';

let connection: ChannelModel | undefined;
let channel: ConfirmChannel | undefined;

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

  await Promise.all([
    rabbitChannel.assertQueue(QueueName.TICKET_PROCESSING, { durable: true }),
    rabbitChannel.assertQueue(QueueName.TICKET_RETRY, { durable: true }),
  ]);

  channel = rabbitChannel;

  return rabbitChannel;
};

/** Return an established publisher/consumer channel. */
export const getRabbitChannel = (): ConfirmChannel => {
  if (!channel) throw new Error('RabbitMQ connection has not been initialized');

  return channel;
};
