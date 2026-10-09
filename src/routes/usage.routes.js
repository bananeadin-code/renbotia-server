import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireBusiness, requireAccess } from '../middleware/tenant.middleware.js';
import { getUsageSummary, getImpactSummary, getAnalytics } from '../controllers/usage.controller.js';

const router = Router();

router.use(requireAuth, requireBusiness);

router.get('/', getUsageSummary);
// Ingresos estimados y leads: información del negocio → requiere ver analíticas.
router.get('/impact', requireAccess('analytics', 'view'), getImpactSummary);
router.get('/analytics', requireAccess('analytics', 'view'), getAnalytics);

export default router;
