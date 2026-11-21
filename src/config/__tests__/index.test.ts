import { required } from '../index';
test('returns a configured value', () => {
  process.env.TRIAGE_TEST_VALUE = 'ready';
  expect(required('TRIAGE_TEST_VALUE')).toBe('ready');
  delete process.env.TRIAGE_TEST_VALUE;
});
test('rejects a missing required value', () => {
  delete process.env.TRIAGE_MISSING_VALUE;
  expect(() => required('TRIAGE_MISSING_VALUE')).toThrow('TRIAGE_MISSING_VALUE is required');
});
