jest.mock('../../../sequelize/models', () => ({
  __esModule: true,
  default: { transaction: jest.fn() },
}));
jest.mock('../../../sequelize/models/tickets.modal', () => ({
  __esModule: true,
  default: { findByPk: jest.fn() },
}));
jest.mock('../../../sequelize/models/ticket_status_history.modal', () => ({
  __esModule: true,
  default: { create: jest.fn() },
}));
jest.mock('../../../rabbitmq/triage', () => ({ probeGeminiConnection: jest.fn() }));
jest.mock('../../../rabbitmq', () => ({
  QueueAction: { PROCESS_TICKET: 'process_ticket' },
  QueueName: { TICKET_PROCESSING: 'ticket_processing' },
  sendToQueue: jest.fn(),
}));

import db from '../../../sequelize/models';
import Ticket from '../../../sequelize/models/tickets.modal';
import TicketStatusHistory from '../../../sequelize/models/ticket_status_history.modal';
import { sendToQueue } from '../../../rabbitmq';
import { probeGeminiConnection } from '../../../rabbitmq/triage';
import { canRetryClassification, retryTicketClassification } from '../helper';
import { TICKET_TRIAGE_FAILURE_CODE, TRIAGE_STATUS } from '../enum';

const retryInput = { requestId: 'request-1', ticketId: 42, actorUserId: 7 };

beforeEach(() => {
  jest.clearAllMocks();
});

test('allows retry only for a Gemini connection failure in manual review', () => {
  expect(
    canRetryClassification({
      triage_status: TRIAGE_STATUS.MANUAL_REVIEW,
      triage_failure_code: TICKET_TRIAGE_FAILURE_CODE.GEMINI_CONNECTION,
    })
  ).toBe(true);
  expect(
    canRetryClassification({
      triage_status: TRIAGE_STATUS.MANUAL_REVIEW,
      triage_failure_code: TICKET_TRIAGE_FAILURE_CODE.INVALID_CLASSIFICATION,
    })
  ).toBe(false);
  expect(
    canRetryClassification({
      triage_status: TRIAGE_STATUS.PENDING,
      triage_failure_code: TICKET_TRIAGE_FAILURE_CODE.GEMINI_CONNECTION,
    })
  ).toBe(false);
});

test('stops before Gemini and the transaction when the ticket does not exist', async () => {
  (Ticket.findByPk as jest.Mock).mockResolvedValue(null);

  await expect(retryTicketClassification(retryInput)).resolves.toEqual({ kind: 'notFound' });
  expect(probeGeminiConnection).not.toHaveBeenCalled();
  expect(db.transaction).not.toHaveBeenCalled();
});

test('stops before the transaction when the Gemini availability probe fails', async () => {
  (Ticket.findByPk as jest.Mock).mockResolvedValue({
    triage_status: TRIAGE_STATUS.MANUAL_REVIEW,
    triage_failure_code: TICKET_TRIAGE_FAILURE_CODE.GEMINI_CONNECTION,
  });
  (probeGeminiConnection as jest.Mock).mockResolvedValue(false);

  await expect(retryTicketClassification(retryInput)).resolves.toEqual({
    kind: 'geminiUnavailable',
  });
  expect(probeGeminiConnection).toHaveBeenCalledTimes(1);
  expect(db.transaction).not.toHaveBeenCalled();
});

test('updates history and publishes the ticket after Gemini is available', async () => {
  const currentTicket = {
    triage_status: TRIAGE_STATUS.MANUAL_REVIEW,
    triage_failure_code: TICKET_TRIAGE_FAILURE_CODE.GEMINI_CONNECTION,
    status_reason: 'Gemini connection failed',
    processing_started_at: new Date(),
    completed_at: new Date(),
    retry_count: 2,
    save: jest.fn().mockResolvedValue(undefined),
  };
  (Ticket.findByPk as jest.Mock)
    .mockResolvedValueOnce({
      triage_status: TRIAGE_STATUS.MANUAL_REVIEW,
      triage_failure_code: TICKET_TRIAGE_FAILURE_CODE.GEMINI_CONNECTION,
    })
    .mockResolvedValueOnce(currentTicket);
  (probeGeminiConnection as jest.Mock).mockResolvedValue(true);
  (db.transaction as jest.Mock).mockImplementation(async (callback) =>
    callback({ LOCK: { UPDATE: 'UPDATE' } })
  );
  (TicketStatusHistory.create as jest.Mock).mockResolvedValue(undefined);
  (sendToQueue as jest.Mock).mockResolvedValue(undefined);

  await expect(retryTicketClassification(retryInput)).resolves.toEqual({ kind: 'accepted' });
  expect(currentTicket.triage_status).toBe(TRIAGE_STATUS.PENDING);
  expect(currentTicket.triage_failure_code).toBeNull();
  expect(currentTicket.save).toHaveBeenCalledTimes(1);
  expect(TicketStatusHistory.create).toHaveBeenCalledWith(
    expect.objectContaining({
      ticket_id: retryInput.ticketId,
      actor_user_id: retryInput.actorUserId,
      new_status: TRIAGE_STATUS.PENDING,
      retry_count: 2,
    }),
    expect.any(Object)
  );
  expect(sendToQueue).toHaveBeenCalledWith(
    expect.objectContaining({ payload: { ticketId: retryInput.ticketId } })
  );
});
