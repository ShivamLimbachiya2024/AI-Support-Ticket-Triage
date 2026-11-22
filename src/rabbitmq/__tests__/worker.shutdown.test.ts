const mockProcessTicket = jest.fn();

jest.mock('../../sequelize/models', () => ({ __esModule: true, default: {} }));
jest.mock('../../sequelize/models/tickets.modal', () => ({
  __esModule: true,
  default: { findAll: jest.fn() },
}));
jest.mock('../../sequelize/models/ticket_status_history.modal', () => ({
  __esModule: true,
  default: { create: jest.fn() },
}));
jest.mock('../handlers/ticketProcessing.handler', () => ({ processTicket: mockProcessTicket }));

import { EventEmitter } from 'events';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import Ticket from '../../sequelize/models/tickets.modal';
import { QueueAction, QueueName } from '../enums';
import { startQueueWorker } from '../workers/worker';

beforeEach(() => {
  jest.clearAllMocks();
  (Ticket.findAll as jest.Mock).mockResolvedValue([]);
});

test('cancels the consumer and waits for active work before stopping', async () => {
  let receiveMessage: ((message: ConsumeMessage | null) => Promise<void>) | undefined;
  const channel = Object.assign(new EventEmitter(), {
    prefetch: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn(async (_queueName: string, callback: typeof receiveMessage) => {
      receiveMessage = callback;
      return { consumerTag: 'ticket-worker' };
    }),
    cancel: jest.fn().mockResolvedValue(undefined),
    ack: jest.fn(),
    reject: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  }) as unknown as ConfirmChannel;
  let finishHandler!: (shouldRetry: boolean) => void;
  (mockProcessTicket as jest.Mock).mockReturnValue(
    new Promise<boolean>((resolve) => {
      finishHandler = resolve;
    })
  );

  const stopWorker = await startQueueWorker({
    queueName: QueueName.TICKET_PROCESSING,
    channel,
  });
  const message = {
    fields: { redelivered: false },
    content: Buffer.from(JSON.stringify({ action: QueueAction.PROCESS_TICKET, ticketId: 12 })),
  } as ConsumeMessage;
  const messageWork = receiveMessage?.(message);
  let stopped = false;
  const stopping = stopWorker().then(() => {
    stopped = true;
  });

  await Promise.resolve();
  expect(channel.cancel).toHaveBeenCalledWith('ticket-worker');
  expect(stopped).toBe(false);
  finishHandler(false);
  await messageWork;
  await stopping;

  expect(channel.ack).toHaveBeenCalledWith(message);
  expect(stopped).toBe(true);
});
