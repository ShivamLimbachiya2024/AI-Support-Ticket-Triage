import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import type { Server } from 'http';
import router from './router';
import db from './sequelize/models';
import { APP_MODE, CONSUMER_TOPIC, FRONT_URL, PORT } from './config';
import { errorHandler, notFoundHandler, requestLog } from './middleware';
import { logger } from './logger';
import {
  closeRabbitMq,
  connectRabbitMq,
  QueueName,
  startQueueWorker,
  startTicketProcessingOutboxPublisher,
} from './rabbitmq';
const app = express();
let server: Server | undefined;
let stopWorker: (() => Promise<void>) | undefined;
let stopOutboxPublisher: (() => Promise<void>) | undefined;
let shutdownPromise: Promise<void> | undefined;
let isShuttingDown = false;

app.use(requestLog);
app.use(cors({ origin: FRONT_URL, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(router);
app.use(notFoundHandler);
app.use(errorHandler);
const start = async () => {
  logger.info(`Application startup started in ${APP_MODE} mode`);
  logger.info('PostgreSQL connection check started');
  await db.authenticate();
  logger.info('PostgreSQL connection established');
  if (isShuttingDown) return;

  if (APP_MODE === 'worker') {
    logger.info(`Resolving worker queue from CONSUMER_TOPIC=${CONSUMER_TOPIC}`);
    const queueName = Object.values(QueueName).find((queue) => queue === CONSUMER_TOPIC);

    if (!queueName) {
      logger.error(
        'Worker startup stopped because CONSUMER_TOPIC does not name a configured queue'
      );
      throw new Error('CONSUMER_TOPIC must name a configured RabbitMQ queue');
    }

    logger.info(`Starting the ${queueName} worker`);
    const channel = await connectRabbitMq();
    if (isShuttingDown) return;
    stopWorker = await startQueueWorker({ queueName, channel });
    if (isShuttingDown) {
      await stopWorker();
      return;
    }
    stopOutboxPublisher = startTicketProcessingOutboxPublisher();
    channel.once('close', () => {
      if (isShuttingDown) return;
      logger.error(`RabbitMQ worker channel closed for ${queueName}`);
      void shutdown({ reason: 'RabbitMQ channel closed', exitCode: 1 });
    });
    logger.info(`The ${queueName} worker started successfully`);
    return;
  }

  if (APP_MODE === 'api') {
    stopOutboxPublisher = startTicketProcessingOutboxPublisher();
    logger.info(`Starting API listener on port ${PORT}`);
    server = app.listen(PORT, () => logger.info('API listening on port ' + PORT));
  }
};

const shutdown = ({ reason, exitCode }: { reason: string; exitCode: number }): Promise<void> => {
  if (shutdownPromise) return shutdownPromise;
  isShuttingDown = true;
  process.exitCode = exitCode;
  shutdownPromise = (async () => {
    logger.info(`Application shutdown started: ${reason}`);

    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      logger.info('HTTP server stopped accepting requests');
    }
    await stopWorker?.();
    await stopOutboxPublisher?.();
    await closeRabbitMq();
    await db.close();
    logger.info('Application shutdown completed');
  })().catch((error: unknown) => {
    let errorName = 'an unknown error';
    if (error instanceof Error) errorName = error.name;
    logger.error(`Application shutdown failed with ${errorName}`);
    process.exitCode = 1;
  });
  return shutdownPromise;
};

process.once('SIGINT', () => void shutdown({ reason: 'SIGINT received', exitCode: 0 }));
process.once('SIGTERM', () => void shutdown({ reason: 'SIGTERM received', exitCode: 0 }));

start().catch((error: unknown) => {
  let errorMessage = 'an unknown error';
  if (error instanceof Error) errorMessage = error.message;
  logger.error(`Startup failed with ${errorMessage}`);
  void shutdown({ reason: 'startup failure', exitCode: 1 });
});
export default app;
