import { classifyProviderError } from '../../utils/retry';

test('classifies rate limit, permanent, and transient failures', () => {
  expect(classifyProviderError({ error: { status: 429 } }).kind).toBe('rateLimit');
  expect(classifyProviderError({ error: { status: 400 } }).kind).toBe('invalidRequest');
  expect(classifyProviderError({ error: { status: 503 } }).kind).toBe('transient');
  expect(
    classifyProviderError({ error: { status: 429, headers: { 'retry-after': '3600' } } })
  ).toEqual({ kind: 'rateLimit' });
});
