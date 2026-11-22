export enum QueueName {
  TICKET_PROCESSING = 'ticket_processing',
}

export enum QueueAction {
  PROCESS_TICKET = 'process_ticket',
}

export enum GEMINI_FAILURE_KIND {
  CONNECTION = 'connection',
  TRANSIENT = 'transient',
  RATE_LIMIT = 'rateLimit',
  PAYMENT_REQUIRED = 'paymentRequired',
  CONFIGURATION = 'configuration',
  INVALID_REQUEST = 'invalidRequest',
  UNCLASSIFIED = 'unclassified',
}
