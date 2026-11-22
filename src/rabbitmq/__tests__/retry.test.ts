import _ from 'lodash';
import { GoogleGenAI } from '@google/genai';
import { classifyProviderError } from '../../utils/retry';

test('classifies rate limit, permanent, and transient failures', () => {
  const rateLimitError = new Error('Rate limit exceeded') as Error & { status: number };
  rateLimitError.status = 429;
  const invalidRequestError = new Error('Invalid request') as Error & { status: number };
  invalidRequestError.status = 400;
  const transientError = new Error('Service unavailable') as Error & { status: number };
  transientError.status = 503;
  const paymentError = new Error('Payment required') as Error & { status: number };
  paymentError.status = 402;
  const configurationError = new Error('Invalid credentials') as Error & { status: number };
  configurationError.status = 403;
  const retryAfterError = new Error('Rate limit exceeded') as Error & {
    status: number;
    headers: { 'retry-after': string };
  };
  retryAfterError.status = 429;
  retryAfterError.headers = { 'retry-after': '3600' };

  expect(classifyProviderError({ error: rateLimitError }).kind).toBe('rateLimit');
  expect(classifyProviderError({ error: invalidRequestError }).kind).toBe('invalidRequest');
  expect(classifyProviderError({ error: transientError }).kind).toBe('transient');
  expect(classifyProviderError({ error: paymentError }).kind).toBe('paymentRequired');
  expect(classifyProviderError({ error: configurationError }).kind).toBe('configuration');
  expect(classifyProviderError({ error: retryAfterError })).toEqual({ kind: 'rateLimit' });
});

test('recognizes wrapped Node and Gemini SDK transport failures without trusting messages', () => {
  const transportError = { code: 'ECONNRESET' };
  const fetchError = _.assign(new TypeError('fetch failed'), { cause: transportError });
  const wrapped = _.assign(new Error('Gemini request failed'), { cause: fetchError });

  expect(classifyProviderError({ error: wrapped }).kind).toBe('connection');
  expect(classifyProviderError({ error: transportError }).kind).toBe('connection');
  expect(classifyProviderError({ error: new TypeError('fetch failed') }).kind).toBe('unclassified');
  expect(classifyProviderError({ error: { name: 'APIConnectionError' } }).kind).toBe('connection');
  expect(classifyProviderError({ error: { name: 'APIConnectionTimeoutError' } }).kind).toBe(
    'connection'
  );
  expect(classifyProviderError({ error: { name: 'RequestTimeoutError' } }).kind).toBe('connection');
  expect(classifyProviderError({ error: { name: 'APIUserAbortError' } }).kind).toBe('unclassified');
  expect(classifyProviderError({ error: new DOMException('Cancelled', 'AbortError') }).kind).toBe(
    'unclassified'
  );
  expect(classifyProviderError({ error: { cause: { name: 'TimeoutError' } } }).kind).toBe(
    'connection'
  );
});

test('gives HTTP status precedence and handles cyclic causes', () => {
  const rejected = { status: 403, code: 'ECONNRESET' };
  expect(classifyProviderError({ error: { code: 'ECONNRESET', cause: rejected } }).kind).toBe(
    'configuration'
  );
  expect(classifyProviderError({ error: { status: 418, code: 'ECONNRESET' } }).kind).toBe(
    'unclassified'
  );

  const cyclic: { cause?: unknown } = {};
  cyclic.cause = { cause: cyclic };
  expect(classifyProviderError({ error: cyclic }).kind).toBe('unclassified');
  expect(classifyProviderError({ error: null }).kind).toBe('unclassified');
});

test('classifies a timeout surfaced by the installed Gemini SDK as retryable', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = jest.fn(async () => {
    const timeoutError = new Error('Gemini request timed out');
    timeoutError.name = 'TimeoutError';
    throw timeoutError;
  });
  const ai = new GoogleGenAI({
    apiKey: 'unit-test-key',
    httpOptions: { timeout: 50, retryOptions: { attempts: 1 } },
  });
  let caughtError: unknown;

  try {
    await ai.models.generateContent({ model: 'test-model', contents: 'test' });
  } catch (error) {
    caughtError = error;
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(caughtError).toBeInstanceOf(Error);
  expect((caughtError as Error).name).toBe('TimeoutError');
  expect(classifyProviderError({ error: caughtError }).kind).toBe('connection');
});
