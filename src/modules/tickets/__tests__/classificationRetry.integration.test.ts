import 'express-async-errors';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, mock, test } from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';
import _ from 'lodash';
import { randomUUID } from 'crypto';
import type { Server } from 'http';
import type { ConfirmChannel } from 'amqplib';
import { JWT_SECRET, MODEL_NAME } from '../../../config';
import { logger } from '../../../logger';
import { errorHandler } from '../../../middleware';
import router from '../../../router';
import db from '../../../sequelize/models';
import Ticket from '../../../sequelize/models/tickets.modal';
import TicketProcessingOutbox from '../../../sequelize/models/ticket_processing_outbox.modal';
import TicketStatusHistory from '../../../sequelize/models/ticket_status_history.modal';
import TriageCache from '../../../sequelize/models/triage_cache.modal';
import User from '../../../sequelize/models/users.modal';
import { connectRabbitMq } from '../../../rabbitmq/connection';
import { QueueAction, QueueName } from '../../../rabbitmq/enums';
import { processTicket } from '../../../rabbitmq/handlers/ticketProcessing.handler';
import { startTicketProcessingOutboxPublisher } from '../../../rabbitmq/outboxPublisher';
import { sendToQueue } from '../../../rabbitmq/publisher';
import { startQueueWorker } from '../../../rabbitmq/workers/worker';
import { USER_ROLE } from '../../auth/enum/role';
import { TICKET_STATUS_REASON, TICKET_TRIAGE_FAILURE_CODE, TRIAGE_STATUS } from '../enum';
import { recoverStaleTickets } from '../helper/staleTicketRecovery.helper';

// Use disposable PostgreSQL and RabbitMQ instances. The broker test deletes its queue.
describe('support classification retry with PostgreSQL, RabbitMQ and the Gemini SDK', () => {
  const apiFetch = globalThis.fetch;
  const providerFetch = mock.method(globalThis, 'fetch');
  let server: Server;
  let baseUrl: string;
  let broker: ConfirmChannel | undefined;
  let supportId: number;
  let customerId: number;
  let customerEmail: string;

  before(async () => {
    logger.level = 'silent';
    broker = await connectRabbitMq();
    const accounts = await User.bulkCreate(
      [USER_ROLE.SUPPORT, USER_ROLE.CUSTOMER].map((role) => ({
        first_name: 'Retry',
        last_name: 'Integration',
        email: `${randomUUID()}@example.test`,
        password_hash: 'unused by token-based tests',
        role,
      }))
    );
    supportId = Number(accounts[0].id);
    customerId = Number(accounts[1].id);
    customerEmail = accounts[1].email;
    const app = express();
    app.use(express.json(), router, errorHandler);
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const address = server.address();
    assert(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}/api/tickets`;
  });

  after(async () => {
    providerFetch.mock.restore();
    if (broker) await broker.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (customerId) await User.destroy({ where: { id: [supportId, customerId] }, force: true });
    await db.close();
  });

  beforeEach(() => {
    providerFetch.mock.resetCalls();
    providerFetch.mock.mockImplementation(async () => {
      throw new Error('Unexpected Gemini request');
    });
  });

  const makeTicket = async (triageFailureCode?: TICKET_TRIAGE_FAILURE_CODE) =>
    Ticket.create({
      customer_id: customerId,
      subject: `Account issue ${randomUUID()}`,
      body: 'Please reset my password.',
      customer_email: customerEmail,
      triage_status: triageFailureCode ? TRIAGE_STATUS.MANUAL_REVIEW : TRIAGE_STATUS.PENDING,
      status_reason: triageFailureCode
        ? TICKET_STATUS_REASON.GEMINI_CONNECTION_FAILED
        : TICKET_STATUS_REASON.SUBMITTED,
      triage_failure_code: triageFailureCode ?? null,
      processing_attempt: triageFailureCode ? 1 : 0,
      retry_count: 0,
    });

  const request = ({
    path,
    role = USER_ROLE.SUPPORT,
    method = 'GET',
    body,
  }: {
    path: string;
    role?: USER_ROLE;
    method?: string;
    body?: object;
  }) =>
    apiFetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${jwt.sign(
          { id: role === USER_ROLE.SUPPORT ? supportId : customerId, role },
          JWT_SECRET
        )}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  const modelResponse = (value: unknown) =>
    Response.json({
      candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(value) }] } }],
    });

  const recoverGemini = ({ confidence = 0.95 }: { confidence?: number } = {}) => {
    providerFetch.mock.mockImplementation(async (url, options) => {
      if (String(url).includes('EmbedContents') || String(url).includes(':embedContent')) {
        const embedding = { values: [1, ...Array(1535).fill(0)] };
        return Response.json({ embedding, embeddings: [embedding] });
      }
      const text = JSON.parse(String(options?.body)).contents[0].parts[0].text;
      if (text === 'Reply OK.') return modelResponse('OK');
      const payload = JSON.parse(text);
      if (payload.candidate) return modelResponse({ accepted: true, reason: 'Supported' });
      return modelResponse({
        category: 'account',
        priority: 'medium',
        summary: 'The customer requests help resetting their password.',
        confidence,
        evidence: ['reset my password'],
      });
    });
  };

  const retry = ({ ticketId, role }: { ticketId: number; role?: USER_ROLE }) =>
    request({ path: `/${ticketId}/retry-classification`, role, method: 'POST' });

  test('keeps scheduled connection retries in manual review until a worker claims them', async () => {
    const ticket = await makeTicket();
    const ticketId = Number(ticket.id);
    let attempts = 0;
    providerFetch.mock.mockImplementation(async (url) => {
      if (!String(url).endsWith(':generateContent')) {
        const embedding = { values: [1, ...Array(1535).fill(0)] };
        return Response.json({ embedding, embeddings: [embedding] });
      }
      attempts += 1;
      throw _.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    });

    assert.equal(await processTicket({ ticketId }), true);
    // The SDK's installed p-retry stops on Node's fetch failed TypeError.
    assert.equal(attempts, 1);
    const details = await (await request({ path: `/${ticketId}` })).json();
    assert.equal(details.data.ticket.triage_status, TRIAGE_STATUS.MANUAL_REVIEW);
    assert.equal(
      details.data.ticket.status_reason,
      TICKET_STATUS_REASON.GEMINI_CONNECTION_RETRY_SCHEDULED
    );
    assert.equal(details.data.ticket.retry_count, 1);
    assert.equal(details.data.ticket.completed_at, null);
    assert.equal(details.data.canRetryClassification, false);
    const list = await (await request({ path: '?status=manual_review' })).json();
    assert.equal(
      list.data.data.find((row: { id: number }) => row.id === ticket.id)?.canRetryClassification,
      false
    );
    const customer = await (
      await request({ path: `/${ticketId}`, role: USER_ROLE.CUSTOMER })
    ).json();
    assert.deepEqual(customer, {
      data: { id: ticket.id, triage_status: TRIAGE_STATUS.MANUAL_REVIEW },
      message: 'Ticket status retrieved successfully',
      toast: false,
      response_type: 'success',
    });
  });

  test('rejects ineligible retries and any request body before invoking Gemini', async () => {
    const ticketId = Number(
      (await makeTicket(TICKET_TRIAGE_FAILURE_CODE.INVALID_CLASSIFICATION)).id
    );
    assert.equal((await retry({ ticketId, role: USER_ROLE.CUSTOMER })).status, 403);
    assert.equal((await retry({ ticketId })).status, 409);
    assert.equal((await retry({ ticketId: 2147483647 })).status, 404);

    const connectionId = Number(
      (await makeTicket(TICKET_TRIAGE_FAILURE_CODE.GEMINI_CONNECTION)).id
    );
    assert.equal(
      (
        await request({
          path: `/${connectionId}/retry-classification`,
          method: 'POST',
          body: { processingAttempt: 2 },
        })
      ).status,
      400
    );
    assert.equal(providerFetch.mock.callCount(), 0);
  });

  for (const status of [401, 402, 403, 429, 503]) {
    test(`HTTP ${status} fails the probe without enqueuing work`, async () => {
      const ticketId = Number((await makeTicket(TICKET_TRIAGE_FAILURE_CODE.GEMINI_CONNECTION)).id);
      providerFetch.mock.mockImplementation(async () =>
        Response.json({ error: { code: status } }, { status })
      );
      assert.equal((await retry({ ticketId })).status, 503);
      assert.equal(providerFetch.mock.callCount(), 1);
      assert.equal((await Ticket.findByPk(ticketId))?.triage_status, TRIAGE_STATUS.MANUAL_REVIEW);
    });
  }

  test('a successful HTTP response without model output does not pass the probe', async () => {
    const ticketId = Number((await makeTicket(TICKET_TRIAGE_FAILURE_CODE.GEMINI_CONNECTION)).id);
    providerFetch.mock.mockImplementation(async () =>
      Response.json({ promptFeedback: { blockReason: 'SAFETY' } })
    );
    assert.equal((await retry({ ticketId })).status, 503);
  });

  test(
    'the probe rejects TLS failures and enforces the SDK request deadline',
    { timeout: 9000 },
    async () => {
      const ticketId = Number((await makeTicket(TICKET_TRIAGE_FAILURE_CODE.GEMINI_CONNECTION)).id);
      const tlsError = _.assign(new TypeError('fetch failed'), {
        cause: { code: 'CERT_HAS_EXPIRED' },
      });
      providerFetch.mock.mockImplementationOnce(async () => {
        throw tlsError;
      });
      assert.equal((await retry({ ticketId })).status, 503);

      providerFetch.mock.mockImplementationOnce(
        async (_url, options) =>
          new Promise<Response>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
              once: true,
            });
          })
      );
      assert.equal((await retry({ ticketId })).status, 503);
      assert.equal(providerFetch.mock.callCount(), 2);
    }
  );

  test('an SDK HTTP failure during initial triage uses the automatic HTTP retry policy', async () => {
    const ticketId = Number((await makeTicket()).id);
    providerFetch.mock.mockImplementation(async () =>
      Response.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }, { status: 429 })
    );
    assert.equal(await processTicket({ ticketId }), true);
    const ticket = await Ticket.findByPk(ticketId);
    assert.equal(ticket?.triage_status, TRIAGE_STATUS.RETRY_WAIT);
    assert.equal(ticket.retry_count, 1);
    assert.equal(ticket.triage_failure_code, null);
  });

  test(
    'retries Gemini timeouts three times, stays in manual review while scheduled, then allows support retry',
    { timeout: 8000 },
    async () => {
      const ticketId = Number((await makeTicket()).id);
      let timeoutAttempts = 0;
      providerFetch.mock.mockImplementation(async (url) => {
        if (!String(url).endsWith(':generateContent')) {
          const embedding = { values: [1, ...Array(1535).fill(0)] };
          return Response.json({ embedding, embeddings: [embedding] });
        }
        timeoutAttempts += 1;
        throw new DOMException('Gemini request timed out', 'TimeoutError');
      });

      for (let attempt = 1; attempt <= 4; attempt += 1) {
        assert.equal(await processTicket({ ticketId }), attempt < 4);
        const ticket = await Ticket.findByPk(ticketId);
        assert.equal(ticket?.triage_status, TRIAGE_STATUS.MANUAL_REVIEW);
        assert.equal(ticket?.retry_count, Math.min(attempt, 3));
        assert.equal(
          ticket?.status_reason,
          attempt < 4
            ? TICKET_STATUS_REASON.GEMINI_CONNECTION_RETRY_SCHEDULED
            : TICKET_STATUS_REASON.GEMINI_CONNECTION_FAILED
        );
        assert.equal(
          ticket?.completed_at === null,
          attempt < 4,
          'scheduled connection retries stay incomplete until the retry budget is exhausted'
        );
        const details = await (await request({ path: `/${ticketId}` })).json();
        assert.equal(details.data.canRetryClassification, attempt === 4);
      }

      assert(timeoutAttempts >= 4, 'each delayed worker attempt should reach Gemini');
    }
  );

  test(
    'locks a scheduled connection retry into processing before a duplicate delivery can claim it',
    { timeout: 8000 },
    async () => {
      const ticketId = Number((await makeTicket()).id);
      providerFetch.mock.mockImplementation(async (url) => {
        if (!String(url).endsWith(':generateContent')) {
          const embedding = { values: [1, ...Array(1535).fill(0)] };
          return Response.json({ embedding, embeddings: [embedding] });
        }
        throw _.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      });
      assert.equal(await processTicket({ ticketId }), true);

      let announceInference!: () => void;
      let resumeInference!: () => void;
      const inferenceStarted = new Promise<void>((resolve) => {
        announceInference = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        resumeInference = resolve;
      });
      let generationCalls = 0;
      providerFetch.mock.mockImplementation(async (url, options) => {
        if (!String(url).endsWith(':generateContent')) {
          const embedding = { values: [1, ...Array(1535).fill(0)] };
          return Response.json({ embedding, embeddings: [embedding] });
        }
        generationCalls += 1;
        if (generationCalls === 1) {
          announceInference();
          await resume;
        }
        const text = JSON.parse(String(options?.body)).contents[0].parts[0].text;
        if (text === 'Reply OK.') return modelResponse('OK');
        const payload = JSON.parse(text);
        if (payload.candidate) return modelResponse({ accepted: true, reason: 'Supported' });
        return modelResponse({
          category: 'account',
          priority: 'medium',
          summary: 'The customer requests help resetting a password.',
          confidence: 0.95,
          evidence: ['reset my password'],
        });
      });

      const delayedDelivery = processTicket({ ticketId });
      await inferenceStarted;
      const duplicateDelivery = await processTicket({ ticketId });
      assert.equal(duplicateDelivery, false);
      assert.equal(generationCalls, 1);
      const processingTicket = await Ticket.findByPk(ticketId);
      assert.equal(processingTicket?.triage_status, TRIAGE_STATUS.PROCESSING);
      assert.equal(processingTicket?.processing_attempt, 2);

      resumeInference();
      await delayedDelivery;
      const completedTicket = await Ticket.findByPk(ticketId);
      assert.equal(completedTicket?.triage_status, TRIAGE_STATUS.TRIAGED);
      assert.equal(completedTicket?.processing_attempt, 2);
      assert.equal(
        await TicketStatusHistory.count({
          where: { ticket_id: ticketId, new_status: TRIAGE_STATUS.PROCESSING },
        }),
        2
      );
    }
  );

  test(
    'concurrent requests persist one retry and probe with the configured model and no ticket data',
    { timeout: 8000 },
    async () => {
      const ticketId = Number((await makeTicket(TICKET_TRIAGE_FAILURE_CODE.GEMINI_CONNECTION)).id);
      let finishProbes!: () => void;
      const bothProbes = new Promise<void>((resolve) => {
        finishProbes = resolve;
      });
      let probes = 0;
      providerFetch.mock.mockImplementation(async (url, options) => {
        if (++probes === 2) finishProbes();
        await bothProbes;
        return modelResponse('OK');
      });

      const responses = await Promise.all([retry({ ticketId }), retry({ ticketId })]);
      assert.deepEqual(responses.map(({ status }) => status).sort(), [202, 409]);
      const acceptedResponse = responses.find(({ status }) => status === 202);
      assert(acceptedResponse);
      assert.deepEqual(await acceptedResponse.json(), {
        data: { id: ticketId, triage_status: TRIAGE_STATUS.PENDING },
        message: 'Classification retry accepted',
        toast: false,
        response_type: 'success',
      });
      for (const {
        arguments: [url, options],
      } of providerFetch.mock.calls) {
        assert.equal(new URL(String(url)).origin, 'https://generativelanguage.googleapis.com');
        assert(String(url).endsWith(`/models/${MODEL_NAME}:generateContent`));
        assert(new Headers(options?.headers).get('x-goog-api-key'));
        const { contents } = JSON.parse(String(options?.body));
        assert.equal(contents.length, 1);
        assert.deepEqual(contents[0].parts, [{ text: 'Reply OK.' }]);
      }
      const accepted = await Ticket.findByPk(ticketId);
      assert.equal(accepted?.processing_attempt, 1);
      const history = await TicketStatusHistory.findAll({ where: { ticket_id: ticketId } });
      assert.equal(history.length, 1);
      assert.equal(String(history[0].actor_user_id), String(supportId));
      assert.equal(history[0].new_status, TRIAGE_STATUS.PENDING);
    }
  );

  test(
    'delayed connection retry restores processing while invalid output remains ineligible',
    { timeout: 8000 },
    async () => {
      const ticketId = Number((await makeTicket(TICKET_TRIAGE_FAILURE_CODE.GEMINI_CONNECTION)).id);
      recoverGemini();
      assert.equal((await retry({ ticketId })).status, 202);
      providerFetch.mock.mockImplementation(async () => {
        throw _.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      });
      assert.equal(await processTicket({ ticketId }), true);
      const scheduledRetry = await Ticket.findByPk(ticketId);
      assert.equal(scheduledRetry?.triage_status, TRIAGE_STATUS.MANUAL_REVIEW);
      assert.equal(
        scheduledRetry?.status_reason,
        TICKET_STATUS_REASON.GEMINI_CONNECTION_RETRY_SCHEDULED
      );
      assert.equal(
        scheduledRetry?.triage_failure_code,
        TICKET_TRIAGE_FAILURE_CODE.GEMINI_CONNECTION
      );
      assert.equal((await retry({ ticketId })).status, 409);

      recoverGemini();
      assert.equal(await processTicket({ ticketId }), false);
      const retriedTicket = await Ticket.findByPk(ticketId);
      assert.equal(retriedTicket?.triage_status, TRIAGE_STATUS.TRIAGED);
      assert.equal(retriedTicket?.processing_attempt, 2);

      const invalidTicketId = Number(
        (await makeTicket(TICKET_TRIAGE_FAILURE_CODE.GEMINI_CONNECTION)).id
      );
      recoverGemini();
      assert.equal((await retry({ ticketId: invalidTicketId })).status, 202);
      providerFetch.mock.mockImplementation(async () => modelResponse({ category: 'bad output' }));
      assert.equal(await processTicket({ ticketId: invalidTicketId }), false);
      const ticket = await Ticket.findByPk(invalidTicketId);
      assert.equal(ticket?.triage_status, TRIAGE_STATUS.MANUAL_REVIEW);
      assert.equal(ticket.triage_failure_code, TICKET_TRIAGE_FAILURE_CODE.INVALID_CLASSIFICATION);
      assert.equal((await retry({ ticketId: invalidTicketId })).status, 409);
    }
  );

  test(
    'a reclaimed worker attempt fences old delivery and stale completion',
    { timeout: 8000 },
    async () => {
      const ticketId = Number((await makeTicket(TICKET_TRIAGE_FAILURE_CODE.GEMINI_CONNECTION)).id);
      recoverGemini();
      assert.equal((await retry({ ticketId })).status, 202);
      let announceClaim!: () => void;
      let resumeOldWorker!: () => void;
      const claimed = new Promise<void>((resolve) => {
        announceClaim = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        resumeOldWorker = resolve;
      });
      const cacheLookup = mock.method(
        TriageCache,
        'findOne',
        async () => {
          announceClaim();
          await resume;
          return null;
        },
        { times: 1 }
      );

      const staleWorker = processTicket({ ticketId });
      await claimed;
      try {
        await Ticket.update({ processing_started_at: new Date(0) }, { where: { id: ticketId } });
        await recoverStaleTickets();
        const reopened = await Ticket.findByPk(ticketId);
        assert.equal(reopened?.processing_attempt, 2);
        await processTicket({ ticketId });
        assert.equal((await Ticket.findByPk(ticketId))?.triage_status, TRIAGE_STATUS.TRIAGED);
        await processTicket({ ticketId });
      } finally {
        resumeOldWorker();
        await staleWorker;
        cacheLookup.mock.restore();
      }
      const ticket = await Ticket.findByPk(ticketId);
      assert.equal(ticket?.triage_status, TRIAGE_STATUS.TRIAGED);
      assert.equal(ticket.processing_attempt, 3);
      assert.equal(
        await TicketStatusHistory.count({
          where: { ticket_id: ticketId, new_status: TRIAGE_STATUS.TRIAGED },
        }),
        1
      );
    }
  );

  test(
    'durably records retries during a broker outage and handles duplicate delivery once',
    { timeout: 8000 },
    async () => {
      const ticketId = Number((await makeTicket(TICKET_TRIAGE_FAILURE_CODE.GEMINI_CONNECTION)).id);
      recoverGemini({ confidence: 0.5 });
      assert(broker);
      await TicketProcessingOutbox.destroy({ where: {} });
      await broker.deleteQueue(QueueName.TICKET_PROCESSING);
      const accepted = await retry({ ticketId });
      assert.equal(accepted.status, 202);
      const waiting = await Ticket.findByPk(ticketId);
      assert.equal(waiting?.triage_status, TRIAGE_STATUS.PENDING);
      assert.equal(waiting?.triage_failure_code, null);
      assert.equal(await TicketStatusHistory.count({ where: { ticket_id: ticketId } }), 1);

      await broker.close();
      broker = await connectRabbitMq();
      let stopOutboxPublisher: (() => Promise<void>) | undefined;
      let stopWorker: (() => Promise<void>) | undefined;
      try {
        stopOutboxPublisher = startTicketProcessingOutboxPublisher();
        const publishDeadline = Date.now() + 4000;
        let queued = false;
        while (!queued && Date.now() < publishDeadline) {
          queued = (await broker.checkQueue(QueueName.TICKET_PROCESSING)).messageCount > 0;
          if (!queued) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.equal((await broker.checkQueue(QueueName.TICKET_PROCESSING)).messageCount, 1);
        await sendToQueue({
          queueName: QueueName.TICKET_PROCESSING,
          action: QueueAction.PROCESS_TICKET,
          payload: { ticketId },
        });
        assert.equal((await broker.checkQueue(QueueName.TICKET_PROCESSING)).messageCount, 2);
        stopWorker = await startQueueWorker({
          queueName: QueueName.TICKET_PROCESSING,
          channel: broker,
        });
        const deadline = Date.now() + 4000;
        let completed = false;
        while (!completed && Date.now() < deadline) {
          const currentTicket = await Ticket.findByPk(ticketId);
          completed =
            currentTicket?.triage_status === TRIAGE_STATUS.MANUAL_REVIEW &&
            currentTicket.triage_failure_code === TICKET_TRIAGE_FAILURE_CODE.LOW_CONFIDENCE;
          if (!completed) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert(completed);
        assert.equal(
          await TicketStatusHistory.count({
            where: { ticket_id: ticketId, new_status: TRIAGE_STATUS.PROCESSING },
          }),
          1
        );
        const details = await (await request({ path: `/${ticketId}` })).json();
        assert.equal(details.data.ticket.triage_status, TRIAGE_STATUS.MANUAL_REVIEW);
        assert.equal(
          details.data.ticket.triage_failure_code,
          TICKET_TRIAGE_FAILURE_CODE.LOW_CONFIDENCE
        );
        assert.equal(details.data.ticket.processing_attempt, 2);
        assert.equal(details.data.canRetryClassification, false);
      } finally {
        await stopWorker?.();
        await stopOutboxPublisher?.();
      }
    }
  );
});
