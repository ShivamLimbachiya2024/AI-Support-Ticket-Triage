import Joi from 'joi';
import _ from 'lodash';
import { TRIAGE_STATUS, TICKET_CATEGORY, TICKET_PRIORITY } from '../enum';

export const submitSchema = Joi.object({
  subject: Joi.string().min(1).max(255).required(),
  body: Joi.string().min(1).max(20000).required(),
  customer_email: Joi.string().email().required(),
});

export const ticketParamsSchema = Joi.object({
  id: Joi.number().integer().min(1).max(Number.MAX_SAFE_INTEGER).required(),
}).required();

export const retryClassificationSchema = Joi.object().max(0).default({});

export interface ListTicketsQuery {
  status?: TRIAGE_STATUS;
  category?: TICKET_CATEGORY;
  priority?: TICKET_PRIORITY;
  page: number;
  limit: number;
}

export const listTicketsQuerySchema = Joi.object({
  status: Joi.string()
    .valid(..._.values(TRIAGE_STATUS))
    .optional(),
  category: Joi.string()
    .valid(..._.values(TICKET_CATEGORY))
    .optional(),
  priority: Joi.string()
    .valid(..._.values(TICKET_PRIORITY))
    .optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
})
  .required()
  .unknown(false);
