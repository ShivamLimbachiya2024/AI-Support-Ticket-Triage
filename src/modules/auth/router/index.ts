import { Router } from 'express';
import { authenticate, validate } from '../../../middleware';
import { userLoginSchema, userValidationSchema } from '../validation-schema';
import { isLoggedInUser, loginUser, registerUser } from '../controller';
const router = Router();
router.post('/auth/register', validate(userValidationSchema), registerUser);
router.post('/auth/login', validate(userLoginSchema), loginUser);
router.get('/auth/me', authenticate, isLoggedInUser);
export default router;
