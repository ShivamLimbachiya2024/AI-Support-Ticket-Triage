import Joi from 'joi';
export const submitSchema = Joi.object({
  subject: Joi.string().min(1).max(255).required(),
  body: Joi.string().min(1).max(20000).required(),
  customer_email: Joi.string().email().required(),
});
