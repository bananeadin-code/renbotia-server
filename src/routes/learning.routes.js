import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireBusiness, requirePermission } from '../middleware/tenant.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as learning from '../controllers/learning.controller.js';

const router = Router();
router.use(requireAuth, requireBusiness);

// Cualquier miembro que entrena el bot puede enseñarle (igual que Entrenamiento).
router.get('/', learning.listSuggestions);
router.post('/:id/accept', requirePermission('training'), validate(learning.acceptSchema), learning.acceptSuggestion);
router.post('/:id/dismiss', requirePermission('training'), learning.dismissSuggestion);

export default router;
