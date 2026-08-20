import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireBusiness } from '../middleware/tenant.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as conversations from '../controllers/conversations.controller.js';

const router = Router();

// Conversaciones = para todos los planes (dueño y colaboradores del negocio).
router.use(requireAuth, requireBusiness);

router.get('/', conversations.listConversations);
router.get('/:id', conversations.getConversation);
router.patch('/:id', validate(conversations.updateConversationSchema), conversations.updateConversation);
router.post('/:id/reply', validate(conversations.replySchema), conversations.replyAsAgent);

export default router;
