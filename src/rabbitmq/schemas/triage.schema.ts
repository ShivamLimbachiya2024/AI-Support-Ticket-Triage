import Joi from 'joi';
import _ from 'lodash';
import { TICKET_CATEGORY, TICKET_PRIORITY } from '../../modules/tickets/enum';

/** Accepted shape for a result saved to the database. */
export const resultSchema = Joi.object({
  category: Joi.string()
    .valid(..._.values(TICKET_CATEGORY))
    .required(),
  priority: Joi.string()
    .valid(..._.values(TICKET_PRIORITY))
    .required(),
  summary: Joi.string().min(1).max(500).required(),
  confidence: Joi.number().min(0).max(1).optional(),
})
  .required()
  .unknown(false);

/** Candidate shape returned by the model before its evidence is checked. */
export const modelCandidateSchema = Joi.object({
  category: Joi.string()
    .valid(..._.values(TICKET_CATEGORY))
    .required(),
  priority: Joi.string()
    .valid(..._.values(TICKET_PRIORITY))
    .required(),
  summary: Joi.string().min(1).max(500).required(),
  evidence: Joi.array().items(Joi.string().min(1)).min(1).max(3).required(),
  confidence: Joi.number().min(0).max(1).required(),
})
  .required()
  .unknown(false);

/** Shape returned by the independent model judge. */
export const judgeResultSchema = Joi.object({
  accepted: Joi.boolean().required(),
  reason: Joi.string().min(1).max(500).required(),
})
  .required()
  .unknown(false);

/** Shape returned by the semantic reuse verifier. */
export const semanticReuseResultSchema = Joi.object({
  accepted: Joi.boolean().required(),
  summary: Joi.string().min(1).max(500).required(),
  confidence: Joi.number().min(0).max(1).required(),
  evidence: Joi.array().items(Joi.string().min(1)).min(1).max(3).required(),
})
  .required()
  .unknown(false);
