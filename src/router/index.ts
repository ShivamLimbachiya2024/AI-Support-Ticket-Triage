import { Router } from 'express';
import auth from '../modules/auth/router';
import tickets from '../modules/tickets/router';
const router = Router();
router.use('/api', auth);
router.use('/api', tickets);
export default router;
