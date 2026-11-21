export enum TRIAGE_STATUS {
  PENDING = 'pending',
  PROCESSING = 'processing',
  RETRY_WAIT = 'retry_wait',
  TRIAGED = 'triaged',
  MANUAL_REVIEW = 'manual_review',
}
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
