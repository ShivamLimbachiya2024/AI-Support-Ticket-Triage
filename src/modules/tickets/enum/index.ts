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
  CLASSIFICATION_RETRY_REQUESTED = 'Support requested another classification',
  GEMINI_CONNECTION_FAILED = 'Gemini connection failed',
  GEMINI_TEMPORARILY_UNAVAILABLE = 'Gemini temporarily unavailable',
  GEMINI_RATE_LIMITED = 'Gemini rate or quota limit reached',
  GEMINI_PAYMENT_REQUIRED = 'Gemini payment required',
  GEMINI_CONFIGURATION_FAILED = 'Gemini configuration error',
  GEMINI_REQUEST_REJECTED = 'Gemini rejected the classification request',
  INVALID_CLASSIFICATION = 'Gemini returned invalid classification output',
  LOW_CLASSIFICATION_CONFIDENCE = 'Low classification confidence',
  CLASSIFICATION_FAILED = 'Classification failed',
  PROCESSING_TIMEOUT = 'Previous processing attempt timed out',
}

export enum TICKET_TRIAGE_FAILURE_CODE {
  GEMINI_CONNECTION = 'geminiConnection',
  INVALID_CLASSIFICATION = 'invalidClassification',
  LOW_CONFIDENCE = 'lowConfidence',
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
