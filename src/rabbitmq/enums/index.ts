export enum QueueName {
  TICKET_PROCESSING = 'ticket_processing',
  TICKET_RETRY = 'ticket_retry',
}

export enum QueueAction {
  PROCESS_TICKET = 'process_ticket',
  RETRY_TICKET = 'retry_ticket',
}
