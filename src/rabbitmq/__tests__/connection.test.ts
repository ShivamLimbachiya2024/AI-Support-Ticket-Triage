jest.mock('amqplib', () => ({
  __esModule: true,
  default: { connect: jest.fn() },
}));

import { EventEmitter } from 'events';
import amqp from 'amqplib';
import type { ConfirmChannel } from 'amqplib';
import { closeRabbitMq, connectRabbitMq } from '../connection';
import { QueueName } from '../enums';

const createRabbitConnection = () => {
  const channel = Object.assign(new EventEmitter(), {
    assertQueue: jest.fn().mockResolvedValue(undefined),
  });
  const connection = Object.assign(new EventEmitter(), {
    createConfirmChannel: jest.fn().mockResolvedValue(channel),
    close: jest.fn().mockResolvedValue(undefined),
  });
  return { connection, channel };
};

beforeEach(() => {
  (amqp.connect as jest.Mock).mockReset();
});

afterEach(async () => {
  await closeRabbitMq();
});

test('shares a live channel and declares the ticket retry queue', async () => {
  const { connection, channel } = createRabbitConnection();
  (amqp.connect as jest.Mock).mockResolvedValue(connection);

  const first = await connectRabbitMq();
  const second = await connectRabbitMq();

  expect(first).toBe(channel);
  expect(second).toBe(channel);
  expect(amqp.connect).toHaveBeenCalledTimes(1);
  expect(channel.assertQueue).toHaveBeenCalledTimes(1);
  expect(channel.assertQueue).toHaveBeenCalledWith(
    QueueName.TICKET_PROCESSING,
    expect.objectContaining({
      durable: true,
      arguments: expect.objectContaining({
        'x-delayed-retry-type': 'failed',
      }),
    })
  );
});

test('closes the connection and opens a new one on the next request', async () => {
  const firstConnection = createRabbitConnection();
  const secondConnection = createRabbitConnection();
  (amqp.connect as jest.Mock)
    .mockResolvedValueOnce(firstConnection.connection)
    .mockResolvedValueOnce(secondConnection.connection);

  const firstChannel = await connectRabbitMq();
  await closeRabbitMq();
  const secondChannel = await connectRabbitMq();

  expect(firstChannel).not.toBe(secondChannel);
  expect(firstConnection.connection.close).toHaveBeenCalledTimes(1);
  expect(amqp.connect).toHaveBeenCalledTimes(2);
  expect(secondChannel).toBe(secondConnection.channel as unknown as ConfirmChannel);
});
