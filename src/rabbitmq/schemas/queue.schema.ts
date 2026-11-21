import Joi from 'joi';
import { QueueAction } from '../enums';

/** Shared message shape validated before queue handler dispatch. */
export const queuePayloadSchema = Joi.object({
  action: Joi.string()
    .valid(...Object.values(QueueAction))
    .required(),
  ticketId: Joi.number().integer().positive().required(),
  availableAt: Joi.number().integer().optional(),
})
  .required()
  .unknown(false);
