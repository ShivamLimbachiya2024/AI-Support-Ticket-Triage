import { classifyProviderError } from '../../utils/retry';

test('classifies rate limit, permanent, and transient failures', () => {
  const rateLimitError = new Error('Rate limit exceeded') as Error & { status: number };
  rateLimitError.status = 429;
  const invalidRequestError = new Error('Invalid request') as Error & { status: number };
  invalidRequestError.status = 400;
  const transientError = new Error('Service unavailable') as Error & { status: number };
  transientError.status = 503;
  const quotaError = new Error('Quota exhausted') as Error & { status: number };
  quotaError.status = 402;
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
  expect(classifyProviderError({ error: quotaError }).kind).toBe('quota');
  expect(classifyProviderError({ error: configurationError }).kind).toBe('configuration');
  expect(classifyProviderError({ error: retryAfterError })).toEqual({ kind: 'rateLimit' });
});
