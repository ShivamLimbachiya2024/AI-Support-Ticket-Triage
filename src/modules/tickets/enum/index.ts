export enum TRIAGE_STATUS {
  PENDING = 'pending',
  PROCESSING = 'processing',
  RETRY_WAIT = 'retry_wait',
  TRIAGED = 'triaged',
  MANUAL_REVIEW = 'manual_review',
}

export enum TICKET_STATUS_REASON {
  SUBMITTED = 'Ticket submitted',
  PROCESSING_STARTED = 'Processing started',
  RETRY_PROCESSING_STARTED = 'Retry processing started',
  TRIAGE_COMPLETED = 'Triage completed',
  PROCESSING_TIMEOUT = 'Previous processing attempt timed out',
}

export const ticketProcessingReasonByPreviousStatus: Record<
  TRIAGE_STATUS.PENDING | TRIAGE_STATUS.RETRY_WAIT,
  TICKET_STATUS_REASON
> = {
  [TRIAGE_STATUS.PENDING]: TICKET_STATUS_REASON.PROCESSING_STARTED,
  [TRIAGE_STATUS.RETRY_WAIT]: TICKET_STATUS_REASON.RETRY_PROCESSING_STARTED,
};

export enum TICKET_CATEGORY {
  BILLING = 'billing',
  TECHNICAL = 'technical',
  ACCOUNT = 'account',
  FEEDBACK = 'feedback',
  OTHER = 'other',
}
export enum TICKET_PRIORITY {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  URGENT = 'urgent',
}
