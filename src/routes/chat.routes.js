import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireBusiness } from '../middleware/tenant.middleware.js';
import * as chat from '../controllers/chat.controller.js';
import { requirePermission } from '../middleware/tenant.middleware.js';

const router = Router();

router.use(requireAuth, requireBusiness, requirePermission('simulator'));

router.get('/', chat.listChats);
router.get('/:id', chat.getChat);
router.delete('/:id', chat.deleteChat);

export default router;
