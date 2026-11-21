import { retryDelayMs } from '../../utils/retry';
test('uses exponential delays for three retries', () => {
  expect([1, 2, 3].map(retryDelayMs)).toEqual([30000, 60000, 120000]);
});
test('rejects retry counts outside the limit', () => {
  expect(() => retryDelayMs(4)).toThrow();
});
