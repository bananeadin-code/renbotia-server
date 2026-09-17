import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireBusiness } from '../middleware/tenant.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as conversations from '../controllers/conversations.controller.js';

const router = Router();

// Conversaciones = para todos los planes (dueño y colaboradores del negocio).
router.use(requireAuth, requireBusiness);

router.get('/', conversations.listConversations);
router.get('/export', conversations.exportConversations); // antes de /:id (no confundir con un id)
router.get('/templates', conversations.listBusinessTemplates); // plantillas aprobadas de la WABA
router.get('/:id', conversations.getConversation);
router.patch('/:id', validate(conversations.updateConversationSchema), conversations.updateConversation);
router.post('/:id/reply', validate(conversations.replySchema), conversations.replyAsAgent);
router.post('/:id/summary', conversations.summarizeConv);
router.post('/:id/template', validate(conversations.templateSchema), conversations.sendTemplateReply);
router.post('/:id/rate', validate(conversations.rateSchema), conversations.rateMessage);

export default router;
