import { QueueAction, QueueName } from '../enums';

export interface QueuePayload {
  action: QueueAction;
  ticketId: number;
}

export interface QueueMessage {
  queueName: QueueName;
  action: QueueAction;
  payload: Omit<QueuePayload, 'action'>;
}

/** Return true to ask RabbitMQ to delay and redeliver this quorum-queue message. */
export type QueueHandler = (message: QueuePayload) => Promise<boolean>;
