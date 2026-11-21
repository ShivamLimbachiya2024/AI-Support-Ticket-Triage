jest.mock('../../config', () => ({
  EMBEDDING_MODEL: 'fake_embedding_v1',
  GEMINI_API_KEY: undefined,
  MODEL_NAME: 'fake_v1',
  MODEL_PROVIDER: 'fake',
  PROMPT_VERSION: 'test_prompt_version',
}));

import {
  EMBEDDING_DIMENSION,
  embedText,
  formatEmbeddingText,
  runVerifiedTriage,
  triageText,
  validateCandidate,
  validateResult,
} from '../triage';
import { TICKET_CATEGORY, TICKET_PRIORITY } from '../../modules/tickets/enum';

test('accepts a valid triage result', () => {
  expect(
    validateResult({
      category: TICKET_CATEGORY.BILLING,
      priority: TICKET_PRIORITY.HIGH,
      summary: 'The customer needs help with a bill.',
    })
  ).toEqual({
    category: 'billing',
    priority: 'high',
    summary: 'The customer needs help with a bill.',
  });
});
test('rejects an unknown category', () => {
  expect(() =>
    validateResult({ category: 'invented', priority: 'high', summary: 'A summary.' })
  ).toThrow('Invalid model output');
});
test('rejects a missing summary', () => {
  expect(() => validateResult({ category: 'billing', priority: 'high' })).toThrow(
    'Invalid model output'
  );
});

test('accepts a candidate only when its evidence is copied from the source ticket', () => {
  expect(
    validateCandidate({
      ticket: { subject: 'Refund request', body: 'Please refund my last payment.' },
      value: {
        category: TICKET_CATEGORY.BILLING,
        priority: TICKET_PRIORITY.MEDIUM,
        summary: 'The customer requests a refund for their last payment.',
        evidence: ['refund my last payment'],
        confidence: 0.9,
      },
    })
  ).toEqual({
    category: TICKET_CATEGORY.BILLING,
    priority: TICKET_PRIORITY.MEDIUM,
    summary: 'The customer requests a refund for their last payment.',
    confidence: 0.9,
    evidence: ['refund my last payment'],
    confidence: 0.9,
  });
});

test('rejects evidence that does not occur verbatim in the source ticket', () => {
  expect(() =>
    validateCandidate({
      ticket: { subject: 'Refund request', body: 'Please refund my last payment.' },
      value: {
        category: TICKET_CATEGORY.BILLING,
        priority: TICKET_PRIORITY.URGENT,
        summary: 'The customer reports a security breach.',
        evidence: ['security breach'],
        confidence: 0.9,
      },
    })
  ).toThrow('evidence must quote the source ticket exactly');
});

test('rejects a multi-sentence summary even when the output shape and evidence are valid', () => {
  expect(() =>
    validateCandidate({
      ticket: { subject: 'Refund request', body: 'Please refund my last payment.' },
      value: {
        category: TICKET_CATEGORY.BILLING,
        priority: TICKET_PRIORITY.MEDIUM,
        summary: 'The customer requests a refund. They need it today.',
        evidence: ['refund my last payment'],
        confidence: 0.9,
      },
    })
  ).toThrow('summary must be one sentence');
});

test('retries a semantically rejected candidate and accepts a later verified result', async () => {
  const candidate = {
    category: TICKET_CATEGORY.BILLING,
    priority: TICKET_PRIORITY.MEDIUM,
    summary: 'The customer requests a refund for their last payment.',
    confidence: 0.9,
    evidence: ['refund my last payment'],
    confidence: 0.9,
  };
  const generateCandidate = jest.fn(async () => candidate);
  const judgeCandidate = jest
    .fn()
    .mockResolvedValueOnce({
      accepted: false,
      reason: 'The proposed summary adds an unsupported fact.',
    })
    .mockResolvedValueOnce({ accepted: true, reason: 'Supported by the source.' });

  const result = await runVerifiedTriage({
    ticket: { subject: 'Refund request', body: 'Please refund my last payment.' },
    generateCandidate,
    judgeCandidate,
  });

  expect(result).toEqual({
    category: TICKET_CATEGORY.BILLING,
    priority: TICKET_PRIORITY.MEDIUM,
    summary: 'The customer requests a refund for their last payment.',
    confidence: 0.9,
  });
  expect(generateCandidate).toHaveBeenCalledTimes(2);
  expect(generateCandidate.mock.calls[1][0].correctionReason).toContain('unsupported fact');
});

test('sends invalid output to manual review after three local generation attempts', async () => {
  const generateCandidate = jest.fn(async () => ({ category: 'unknown' }));
  const judgeCandidate = jest.fn();

  await expect(
    runVerifiedTriage({
      ticket: { subject: 'Cannot sign in', body: 'I cannot access my account.' },
      generateCandidate,
      judgeCandidate,
    })
  ).rejects.toThrow('validation failed after 3 attempts');

  expect(generateCandidate).toHaveBeenCalledTimes(3);
  expect(judgeCandidate).not.toHaveBeenCalled();
});

test('lets provider failures escape the local output retry loop', async () => {
  const providerError = new Error('Gemini request failed');
  const generateCandidate = jest.fn(async () => {
    throw providerError;
  });

  await expect(
    runVerifiedTriage({
      ticket: { subject: 'Cannot sign in', body: 'I cannot access my account.' },
      generateCandidate,
      judgeCandidate: jest.fn(),
    })
  ).rejects.toBe(providerError);

  expect(generateCandidate).toHaveBeenCalledTimes(1);
});

test('fake provider returns valid triage without an API key', async () => {
  const result = await triageText({ subject: 'Need help', body: 'I have a question' });
  expect(result.category).toBe(TICKET_CATEGORY.OTHER);
});
test('fake embeddings are deterministic and use the configured vector dimension', async () => {
  const first = await embedText({ subject: 'Need help', body: 'I have a question' });
  const second = await embedText({ subject: 'Need help', body: 'I have a question' });
  expect(first).toHaveLength(EMBEDDING_DIMENSION);
  expect(first).toEqual(second);
});

test('formats embeddings for symmetric semantic similarity', () => {
  expect(formatEmbeddingText({ subject: 'Password help', body: 'I cannot sign in.' })).toBe(
    'task: sentence similarity | query: Password help\nI cannot sign in.'
  );
});
