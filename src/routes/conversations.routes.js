import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireBusiness, requireAccess } from '../middleware/tenant.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as conversations from '../controllers/conversations.controller.js';

const router = Router();

// Conversaciones = para todos los planes (dueño y colaboradores del negocio).
router.use(requireAuth, requireBusiness);
// IAM: ver la bandeja exige 'conversations: view' (o el simulador para sus pruebas,
// lo resuelve el controlador por canal); actuar exige 'edit'.

router.get('/', conversations.listConversations);
router.get('/export', requireAccess('conversations', 'view'), conversations.exportConversations); // antes de /:id (no confundir con un id)
router.get('/templates', requireAccess('conversations', 'view'), conversations.listBusinessTemplates); // plantillas aprobadas de la WABA
router.get('/:id', conversations.getConversation);
router.patch('/:id', requireAccess('conversations', 'edit'), validate(conversations.updateConversationSchema), conversations.updateConversation);
router.post('/:id/reply', requireAccess('conversations', 'edit'), validate(conversations.replySchema), conversations.replyAsAgent);
router.post('/:id/summary', requireAccess('conversations', 'edit'), conversations.summarizeConv);
router.post('/:id/template', requireAccess('conversations', 'edit'), validate(conversations.templateSchema), conversations.sendTemplateReply);
router.post('/:id/rate', requireAccess('conversations', 'edit'), validate(conversations.rateSchema), conversations.rateMessage);
router.get('/:id/files/:fileId', conversations.downloadAttachment); // PDF que envió el cliente
router.post('/:id/block', requireAccess('conversations', 'edit'), validate(conversations.blockSchema), conversations.blockContact); // bloquear contacto

export default router;
