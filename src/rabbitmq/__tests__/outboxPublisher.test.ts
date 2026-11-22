jest.mock('../../sequelize/models', () => ({
  __esModule: true,
  default: { transaction: jest.fn() },
}));
jest.mock('../../sequelize/models/ticket_processing_outbox.modal', () => ({
  __esModule: true,
  default: { findAll: jest.fn(), findByPk: jest.fn() },
}));
jest.mock('../publisher', () => ({ sendToQueue: jest.fn() }));

import db from '../../sequelize/models';
import TicketProcessingOutbox from '../../sequelize/models/ticket_processing_outbox.modal';
import { QueueAction, QueueName } from '../enums';
import { sendToQueue } from '../publisher';
import { startTicketProcessingOutboxPublisher } from '../outboxPublisher';

beforeEach(() => {
  jest.clearAllMocks();
  (db.transaction as jest.Mock).mockImplementation(async (callback) =>
    callback({ LOCK: { UPDATE: 'UPDATE' } })
  );
});

test('removes an outbox event only after RabbitMQ confirms it', async () => {
  const message = { id: 1, ticket_id: 42, destroy: jest.fn().mockResolvedValue(undefined) };
  (TicketProcessingOutbox.findAll as jest.Mock).mockResolvedValue([{ id: 1 }]);
  (TicketProcessingOutbox.findByPk as jest.Mock).mockResolvedValue(message);
  (sendToQueue as jest.Mock).mockResolvedValue(undefined);

  const stopPublisher = startTicketProcessingOutboxPublisher();
  await stopPublisher();

  expect(sendToQueue).toHaveBeenCalledWith({
    queueName: QueueName.TICKET_PROCESSING,
    action: QueueAction.PROCESS_TICKET,
    payload: { ticketId: 42 },
  });
  expect(message.destroy).toHaveBeenCalledWith({ transaction: expect.any(Object) });
});

test('keeps the outbox event when RabbitMQ does not confirm the publish', async () => {
  const message = { id: 1, ticket_id: 42, destroy: jest.fn().mockResolvedValue(undefined) };
  (TicketProcessingOutbox.findAll as jest.Mock).mockResolvedValue([{ id: 1 }]);
  (TicketProcessingOutbox.findByPk as jest.Mock).mockResolvedValue(message);
  (sendToQueue as jest.Mock).mockRejectedValue(new Error('broker unavailable'));

  const stopPublisher = startTicketProcessingOutboxPublisher();
  await stopPublisher();

  expect(sendToQueue).toHaveBeenCalledTimes(1);
  expect(message.destroy).not.toHaveBeenCalled();
});
