jest.mock('../../config', () => ({
  EMBEDDING_MODEL: 'test-embedding-model',
  MODEL_NAME: 'test-model',
  PROMPT_VERSION: 'test-prompt-version',
}));
jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));
jest.mock('../../sequelize/models', () => ({
  __esModule: true,
  default: { transaction: jest.fn() },
}));
jest.mock('../../sequelize/models/tickets.modal', () => ({
  __esModule: true,
  default: { findByPk: jest.fn() },
}));
jest.mock('../../sequelize/models/triage_results.modal', () => ({
  __esModule: true,
  default: { findOrCreate: jest.fn() },
}));
jest.mock('../../sequelize/models/ticket_status_history.modal', () => ({
  __esModule: true,
  default: { create: jest.fn() },
}));
jest.mock('../../sequelize/models/ticket_embeddings.modal', () => ({
  __esModule: true,
  default: { findOrCreate: jest.fn(), findOne: jest.fn() },
}));
jest.mock('../triage', () => ({
  cachedTriage: jest.fn(),
  embedText: jest.fn(),
  InvalidClassificationError: class InvalidClassificationError extends Error {},
  verifySemanticReuse: jest.fn(),
  SEMANTIC_REUSE_THRESHOLD: 0.92,
}));

import db from '../../sequelize/models';
import Ticket from '../../sequelize/models/tickets.modal';
import TicketStatusHistory from '../../sequelize/models/ticket_status_history.modal';
import { cachedTriage } from '../triage';
import { processTicket } from '../handlers/ticketProcessing.handler';
import { GeminiRequestError } from '../../utils/retry';
import {
  TICKET_STATUS_REASON,
  TICKET_TRIAGE_FAILURE_CODE,
  TRIAGE_STATUS,
} from '../../modules/tickets/enum';

const retryInput = { ticketId: 42 };
let ticket: Record<string, unknown>;

beforeEach(() => {
  jest.clearAllMocks();
  ticket = {
    id: retryInput.ticketId,
    triage_status: TRIAGE_STATUS.PENDING,
    status_reason: TICKET_STATUS_REASON.SUBMITTED,
    triage_failure_code: null,
    retry_count: 0,
    processing_attempt: 0,
    processing_started_at: null,
    completed_at: null,
    save: jest.fn().mockResolvedValue(undefined),
  };
  (Ticket.findByPk as jest.Mock).mockImplementation(async () => ticket);
  (db.transaction as jest.Mock).mockImplementation(async (callback) =>
    callback({ LOCK: { UPDATE: 'UPDATE' } })
  );
});

test('schedules a bounded connection retry while keeping the ticket in manual review', async () => {
  (cachedTriage as jest.Mock).mockImplementation(async () => {
    expect(ticket.triage_status).toBe(TRIAGE_STATUS.PROCESSING);
    throw new GeminiRequestError({ cause: { code: 'ETIMEDOUT' } });
  });

  await expect(processTicket(retryInput)).resolves.toBe(true);
  expect(ticket.triage_status).toBe(TRIAGE_STATUS.MANUAL_REVIEW);
  expect(ticket.status_reason).toBe(TICKET_STATUS_REASON.GEMINI_CONNECTION_RETRY_SCHEDULED);
  expect(ticket.triage_failure_code).toBe(TICKET_TRIAGE_FAILURE_CODE.GEMINI_CONNECTION);
  expect(ticket.retry_count).toBe(1);
  expect(ticket.completed_at).toBeNull();
  expect(TicketStatusHistory.create).toHaveBeenLastCalledWith(
    expect.objectContaining({
      previous_status: TRIAGE_STATUS.PROCESSING,
      new_status: TRIAGE_STATUS.MANUAL_REVIEW,
      reason: TICKET_STATUS_REASON.GEMINI_CONNECTION_RETRY_SCHEDULED,
      retry_count: 1,
    }),
    expect.any(Object)
  );
});

test('claims only the marked manual-review retry and changes it to processing', async () => {
  ticket.triage_status = TRIAGE_STATUS.MANUAL_REVIEW;
  ticket.status_reason = TICKET_STATUS_REASON.GEMINI_CONNECTION_RETRY_SCHEDULED;
  ticket.triage_failure_code = TICKET_TRIAGE_FAILURE_CODE.GEMINI_CONNECTION;
  ticket.retry_count = 1;
  ticket.processing_attempt = 1;
  (cachedTriage as jest.Mock).mockImplementation(async () => {
    expect(ticket.triage_status).toBe(TRIAGE_STATUS.PROCESSING);
    expect(ticket.status_reason).toBe(TICKET_STATUS_REASON.RETRY_PROCESSING_STARTED);
    throw new GeminiRequestError({ cause: { code: 'ECONNRESET' } });
  });

  await expect(processTicket(retryInput)).resolves.toBe(true);
  expect(ticket.processing_attempt).toBe(2);
  expect(ticket.triage_status).toBe(TRIAGE_STATUS.MANUAL_REVIEW);
  expect(ticket.retry_count).toBe(2);
});

test('skips duplicate delivery while another worker owns the processing state', async () => {
  ticket.triage_status = TRIAGE_STATUS.PROCESSING;
  ticket.processing_attempt = 2;

  await expect(processTicket(retryInput)).resolves.toBe(false);
  expect(cachedTriage).not.toHaveBeenCalled();
  expect(ticket.processing_attempt).toBe(2);
});

test('aborts and stops retrying a ticket attempt when its processing deadline expires', async () => {
  jest.useFakeTimers();
  (cachedTriage as jest.Mock).mockImplementation(
    ({ signal }: { signal: AbortSignal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new GeminiRequestError({ cause: { name: 'AbortError' } })),
          { once: true }
        );
      })
  );

  try {
    const processing = processTicket(retryInput);
    await jest.advanceTimersByTimeAsync(30 * 60 * 1000);

    await expect(processing).resolves.toBe(false);
    expect(ticket.triage_status).toBe(TRIAGE_STATUS.MANUAL_REVIEW);
    expect(ticket.status_reason).toBe(TICKET_STATUS_REASON.PROCESSING_TIMEOUT);
    expect(ticket.retry_count).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});
