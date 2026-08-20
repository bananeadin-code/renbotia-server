import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireAdmin } from '../middleware/role.middleware.js';
import { listAllBusinesses } from '../controllers/admin.controller.js';

const router = Router();

// Solo rol admin. NOTA: no usa requireBusiness — el admin ve todos los negocios.
router.use(requireAuth, requireAdmin);

router.get('/businesses', listAllBusinesses);

export default router;
