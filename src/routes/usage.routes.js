import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireBusiness } from '../middleware/tenant.middleware.js';
import { getUsageSummary, getImpactSummary, getAnalytics } from '../controllers/usage.controller.js';

const router = Router();

router.use(requireAuth, requireBusiness);

router.get('/', getUsageSummary);
router.get('/impact', getImpactSummary);
router.get('/analytics', getAnalytics);

export default router;
