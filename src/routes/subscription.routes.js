import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireBusiness } from '../middleware/tenant.middleware.js';
import { getMySubscription } from '../controllers/subscription.controller.js';

const router = Router();

router.use(requireAuth, requireBusiness);

router.get('/me', getMySubscription);

export default router;
