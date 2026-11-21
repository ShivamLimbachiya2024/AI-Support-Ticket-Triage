import { readFileSync } from 'fs';
import { TICKET_CATEGORY, TICKET_PRIORITY, TRIAGE_STATUS } from '../modules/tickets/enum';

export interface LabeledTicket {
  id: string;
  expectedCategory: TICKET_CATEGORY;
  expectedPriority: TICKET_PRIORITY;
  predictedCategory: TICKET_CATEGORY;
  predictedPriority: TICKET_PRIORITY;
  triageStatus: TRIAGE_STATUS;
  source: string;
  englishSummaryValid: boolean;
}

export const evaluateLabeled = ({ tickets }: { tickets: LabeledTicket[] }) => {
  if (tickets.length === 0) throw new Error('At least one human-labeled ticket is required');
  const reviewed = tickets.filter((ticket) => ticket.triageStatus === TRIAGE_STATUS.MANUAL_REVIEW);
  const automated = tickets.filter((ticket) => ticket.triageStatus === TRIAGE_STATUS.TRIAGED);
  const reused = tickets.filter((ticket) => ticket.source === 'semanticReuse');
  return {
    total: tickets.length,
    categoryAccuracy:
      automated.filter((ticket) => ticket.expectedCategory === ticket.predictedCategory).length /
      Math.max(automated.length, 1),
    priorityAccuracy:
      automated.filter((ticket) => ticket.expectedPriority === ticket.predictedPriority).length /
      Math.max(automated.length, 1),
    urgentMisses: automated.filter(
      (ticket) =>
        ticket.expectedPriority === TICKET_PRIORITY.URGENT &&
        ticket.predictedPriority !== TICKET_PRIORITY.URGENT
    ).length,
    manualReviewRate: reviewed.length / tickets.length,
    semanticReuseErrors: reused.filter(
      (ticket) =>
        ticket.expectedCategory !== ticket.predictedCategory ||
        ticket.expectedPriority !== ticket.predictedPriority
    ).length,
    semanticReuseTotal: reused.length,
    nonEnglishSummaries: tickets.filter((ticket) => !ticket.englishSummaryValid).length,
  };
};

if (require.main === module) {
  const path = process.argv[2];
  if (!path)
    throw new Error('Usage: npx ts-node src/rabbitmq/evaluation.ts <human-labeled-results.json>');
  const tickets = JSON.parse(readFileSync(path, 'utf8')) as LabeledTicket[];
  process.stdout.write(JSON.stringify(evaluateLabeled({ tickets }), null, 2) + '\n');
}
