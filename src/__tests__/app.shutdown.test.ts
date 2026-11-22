const mockStopWorker = jest.fn().mockResolvedValue(undefined);
const mockStopOutboxPublisher = jest.fn().mockResolvedValue(undefined);
const mockChannel = { once: jest.fn() };
const mockApp = { use: jest.fn(), listen: jest.fn() };
const mockExpress = Object.assign(
  jest.fn(() => mockApp),
  {
    json: jest.fn(() => jest.fn()),
  }
);

jest.mock('express-async-errors', () => ({}));
jest.mock('express', () => ({ __esModule: true, default: mockExpress }));
jest.mock('cors', () => ({ __esModule: true, default: jest.fn(() => jest.fn()) }));
jest.mock('cookie-parser', () => ({ __esModule: true, default: jest.fn(() => jest.fn()) }));
jest.mock('../router', () => ({ __esModule: true, default: {} }));
jest.mock('../config', () => ({
  APP_MODE: 'worker',
  CONSUMER_TOPIC: 'ticket_processing',
  FRONT_URL: 'http://localhost',
  PORT: 3000,
}));
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../middleware', () => ({
  errorHandler: jest.fn(),
  notFoundHandler: jest.fn(),
  requestLog: jest.fn(),
}));
jest.mock('../sequelize/models', () => ({
  __esModule: true,
  default: {
    authenticate: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../rabbitmq', () => ({
  closeRabbitMq: jest.fn().mockResolvedValue(undefined),
  connectRabbitMq: jest.fn().mockResolvedValue(mockChannel),
  QueueName: { TICKET_PROCESSING: 'ticket_processing' },
  startQueueWorker: jest.fn().mockResolvedValue(mockStopWorker),
  startTicketProcessingOutboxPublisher: jest.fn(() => mockStopOutboxPublisher),
}));

import db from '../sequelize/models';
import { closeRabbitMq } from '../rabbitmq';
import app from '../app';

test('SIGTERM drains the worker and closes RabbitMQ and PostgreSQL', async () => {
  const previousExitCode = process.exitCode;
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(app).toBeDefined();
  expect(process.emit('SIGTERM')).toBe(true);
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(mockStopWorker).toHaveBeenCalledTimes(1);
  expect(mockStopOutboxPublisher).toHaveBeenCalledTimes(1);
  expect(closeRabbitMq).toHaveBeenCalledTimes(1);
  expect(db.close).toHaveBeenCalledTimes(1);
  expect(mockStopWorker.mock.invocationCallOrder[0]).toBeLessThan(
    mockStopOutboxPublisher.mock.invocationCallOrder[0]
  );
  expect(mockStopOutboxPublisher.mock.invocationCallOrder[0]).toBeLessThan(
    (closeRabbitMq as jest.Mock).mock.invocationCallOrder[0]
  );
  expect((closeRabbitMq as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
    (db.close as jest.Mock).mock.invocationCallOrder[0]
  );
  process.exitCode = previousExitCode;
});
