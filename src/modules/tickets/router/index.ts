import { Router } from 'express';
import { authenticate, validate, validateQuery } from '../../../middleware';
import { listTicketsQuerySchema, submitSchema, ticketParamsSchema } from '../validation-schema';
import { submitTicket, getTicket, listTickets } from '../controller';
const router = Router();
router.post('/tickets', authenticate, validate(submitSchema), submitTicket);
router.get('/tickets', authenticate, validateQuery(listTicketsQuerySchema), listTickets);
router.get('/tickets/:id', authenticate, validate(ticketParamsSchema, 'params'), getTicket);
export default router;
