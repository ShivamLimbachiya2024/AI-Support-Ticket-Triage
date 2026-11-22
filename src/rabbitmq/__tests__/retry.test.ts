import _ from 'lodash';
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

test('recognizes wrapped Node transport failures without trusting generic messages', () => {
  const transportError = { code: 'ECONNRESET' };
  const fetchError = _.assign(new TypeError('fetch failed'), { cause: transportError });
  const wrapped = _.assign(new Error('Gemini request failed'), { cause: fetchError });

  expect(classifyProviderError({ error: wrapped }).kind).toBe('connection');
  expect(classifyProviderError({ error: transportError }).kind).toBe('connection');
  expect(classifyProviderError({ error: new TypeError('fetch failed') }).kind).toBe('unclassified');
  expect(
    classifyProviderError({ error: new DOMException('SDK deadline', 'AbortError') }).kind
  ).toBe('connection');
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
