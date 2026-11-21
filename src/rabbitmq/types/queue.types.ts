import { QueueAction, QueueName } from '../enums';

export interface QueuePayload {
  action: QueueAction;
  ticketId: number;
  availableAt?: number;
}

export interface QueueMessage {
  queueName: QueueName;
  action: QueueAction;
  payload: Omit<QueuePayload, 'action'>;
  delayMs?: number;
}

export type QueueHandler = (message: QueuePayload) => Promise<void>;
