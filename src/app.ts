import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import router from './router';
import db from './sequelize/models';
import { APP_MODE, CONSUMER_TOPIC, FRONT_URL, PORT } from './config';
import { errorHandler, requestLog } from './middleware';
import { logger } from './logger';
import { connectRabbitMq, QueueName, startQueueWorker } from './rabbitmq';
const app = express();
app.use(cors({ origin: FRONT_URL, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(requestLog);
app.use(router);
app.use(errorHandler);
const start = async () => {
  await db.authenticate();
  logger.info('PostgreSQL connection established');
  await connectRabbitMq();

  if (APP_MODE === 'worker') {
    const queueName = Object.values(QueueName).find((queue) => queue === CONSUMER_TOPIC);

    if (!queueName) throw new Error('CONSUMER_TOPIC must name a configured RabbitMQ queue');

    await startQueueWorker(queueName);
    return;
  }

  if (APP_MODE === 'api') app.listen(PORT, () => logger.info('API listening on port ' + PORT));
};
start().catch((error) => {
  logger.error('Startup failed: ' + error.message);
  process.exit(1);
});
export default app;
