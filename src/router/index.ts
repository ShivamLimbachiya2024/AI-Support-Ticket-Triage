import { Router } from 'express';
import health from '../modules/health/router';
import auth from '../modules/auth/router';
import tickets from '../modules/tickets/router';
const router = Router();
router.use('/health', health);
router.use('/api', auth);
router.use('/api', tickets);
export default router;
