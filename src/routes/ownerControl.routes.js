import { Router } from 'express';
import { requireRecentAuth } from '../middleware/stepUp.middleware.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireBusiness, requireBusinessRole } from '../middleware/tenant.middleware.js';
import * as owner from '../controllers/ownerControl.controller.js';

const router = Router();
// Solo el DUEÑO (ni colaboradores con permisos): da control del negocio por WhatsApp.
router.use(requireAuth, requireBusiness, requireBusinessRole('owner'));

router.get('/', owner.getOwnerControl);
router.post('/link-code', requireRecentAuth, owner.createOwnerLinkCode);
router.delete('/:id', requireRecentAuth, owner.unlinkOwner);

export default router;
