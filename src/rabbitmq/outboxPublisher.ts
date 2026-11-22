import db from '../sequelize/models';
import TicketProcessingOutbox from '../sequelize/models/ticket_processing_outbox.modal';
import { logger } from '../logger';
import { QueueAction, QueueName } from './enums';
import { sendToQueue } from './publisher';

const outboxBatchSize = 100;
const outboxPollIntervalMs = 5_000;

const publishPendingMessages = async (): Promise<void> => {
  const pendingMessages = await TicketProcessingOutbox.findAll({
    attributes: ['id'],
    limit: outboxBatchSize,
    order: [['id', 'ASC']],
  });

  for (const pendingMessage of pendingMessages) {
    let ticketId: number | undefined;
    let published = false;
    try {
      await db.transaction(async (transaction) => {
        const message = await TicketProcessingOutbox.findByPk(pendingMessage.id, {
          lock: transaction.LOCK.UPDATE,
          transaction,
        });

        if (!message) return;

        ticketId = Number(message.ticket_id);
        await sendToQueue({
          queueName: QueueName.TICKET_PROCESSING,
          action: QueueAction.PROCESS_TICKET,
          payload: { ticketId },
        });
        await message.destroy({ transaction });
        published = true;
      });
      if (published) logger.info(`Ticket ${ticketId} outbox message published and removed`);
    } catch {
      let ticketDescription = '';
      if (ticketId) ticketDescription = ` for ticket ${ticketId}`;
      logger.warn(
        `Ticket processing outbox delivery failed${ticketDescription}; it will be retried`
      );
      return;
    }
  }
};

/** Publish committed ticket events and retry pending events on the next interval. */
export const startTicketProcessingOutboxPublisher = (): (() => Promise<void>) => {
  let stopped = false;
  let activeRun: Promise<void> | undefined;

  const run = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (activeRun) return activeRun;

    activeRun = publishPendingMessages()
      .catch(() => logger.error('Ticket processing outbox scan failed'))
      .finally(() => {
        activeRun = undefined;
      });
    return activeRun;
  };

  const timer = setInterval(() => void run(), outboxPollIntervalMs);
  void run();

  return async () => {
    clearInterval(timer);
    await run();
    stopped = true;
    await activeRun;
  };
};
