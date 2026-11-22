import { Router } from 'express';
import { authenticate, validate, validateQuery } from '../../../middleware';
import {
  listTicketsQuerySchema,
  submitSchema,
  ticketParamsSchema,
  retryClassificationSchema,
} from '../validation-schema';
import { submitTicket, getTicket, listTickets, retryClassification } from '../controller';
const router = Router();
router.post('/tickets', authenticate, validate(submitSchema), submitTicket);
router.get('/tickets', authenticate, validateQuery(listTicketsQuerySchema), listTickets);
router.get('/tickets/:id', authenticate, validate(ticketParamsSchema, 'params'), getTicket);
router.post(
  '/tickets/:id/retry-classification',
  authenticate,
  validate(ticketParamsSchema, 'params'),
  validate(retryClassificationSchema),
  retryClassification
);
export default router;
