import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireBusiness, requirePermission } from '../middleware/tenant.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as botConfig from '../controllers/botConfig.controller.js';

const router = Router();

router.use(requireAuth, requireBusiness);

router.get('/', botConfig.getBotConfig);
router.put('/', requirePermission('training'), validate(botConfig.updateBotConfigSchema), botConfig.updateBotConfig);

// Avisos temporales (también se ponen desde el WhatsApp del dueño).
router.get('/notices', botConfig.listNotices);
router.post('/notices', requirePermission('training'), validate(botConfig.noticeSchema), botConfig.addNotice);
router.delete('/notices/:id', requirePermission('training'), botConfig.removeNotice);

export default router;
