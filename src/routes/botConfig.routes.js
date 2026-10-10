import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireBusiness, requirePermission, requireAccess } from '../middleware/tenant.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as botConfig from '../controllers/botConfig.controller.js';

const router = Router();

router.use(requireAuth, requireBusiness);

// El simulador también lee el entrenamiento (nombre del bot).
router.get('/', requireAccess(['training', 'view'], ['simulator', 'edit']), botConfig.getBotConfig);
router.put('/', requirePermission('training'), validate(botConfig.updateBotConfigSchema), botConfig.updateBotConfig);

// Avisos temporales (también se ponen desde el WhatsApp del dueño).
router.get('/notices', requireAccess('training', 'view'), botConfig.listNotices);
// Prueba de seguridad del bot: verla con "Entrenamiento: ver"; correrla gasta tokens → "editar".
router.get('/audit', requireAccess('training', 'view'), botConfig.getBotAudit);
router.post('/audit', requireAccess('training', 'edit'), botConfig.postBotAudit);
router.post('/notices', requirePermission('training'), validate(botConfig.noticeSchema), botConfig.addNotice);
router.delete('/notices/:id', requirePermission('training'), botConfig.removeNotice);

export default router;
