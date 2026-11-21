import { evaluateLabeled } from '../evaluation';
import { TICKET_CATEGORY, TICKET_PRIORITY, TRIAGE_STATUS } from '../../modules/tickets/enum';

test('reports urgent misses and semantic reuse errors against human labels', () => {
  expect(
    evaluateLabeled({
      tickets: [
        {
          id: 'case-1',
          expectedCategory: TICKET_CATEGORY.TECHNICAL,
          expectedPriority: TICKET_PRIORITY.URGENT,
          predictedCategory: TICKET_CATEGORY.ACCOUNT,
          predictedPriority: TICKET_PRIORITY.MEDIUM,
          triageStatus: TRIAGE_STATUS.TRIAGED,
          source: 'semanticReuse',
          englishSummaryValid: true,
        },
      ],
    })
  ).toMatchObject({
    total: 1,
    categoryAccuracy: 0,
    priorityAccuracy: 0,
    urgentMisses: 1,
    semanticReuseErrors: 1,
  });
});
