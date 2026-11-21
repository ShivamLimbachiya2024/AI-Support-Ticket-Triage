import { Router } from 'express';
import { authenticate, validate } from '../../../middleware';
import { submitSchema } from '../validation-schema';
import { submitTicket, getTicket, listTickets } from '../controller';
const router = Router();
router.post('/tickets', authenticate, validate(submitSchema), submitTicket);
router.get('/tickets', authenticate, listTickets);
router.get('/tickets/:id', authenticate, getTicket);
export default router;
