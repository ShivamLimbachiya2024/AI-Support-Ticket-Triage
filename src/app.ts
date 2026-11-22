import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import router from './router';
import db from './sequelize/models';
import { APP_MODE, CONSUMER_TOPIC, FRONT_URL, PORT } from './config';
import { errorHandler, notFoundHandler, requestLog } from './middleware';
import { logger } from './logger';
import { connectRabbitMq, QueueName, startQueueWorker } from './rabbitmq';
const app = express();

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
    channel.once('close', () => {
      logger.error(
        `RabbitMQ worker channel closed for ${queueName}. Restarting the worker is required`
      );
      process.exit(1);
    });
    await startQueueWorker({ queueName, channel });
    logger.info(`The ${queueName} worker started successfully`);
    return;
  }

  if (APP_MODE === 'api') {
    logger.info(`Starting API listener on port ${PORT}`);
    app.listen(PORT, () => logger.info('API listening on port ' + PORT));
  }
};
start().catch((error) => {
  logger.error('Startup failed: ' + error.message);
  process.exit(1);
});
export default app;
