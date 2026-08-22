import { Router } from 'express';
import { validate } from '../middleware/validate.middleware.js';
import { demoLimiter } from '../middleware/rateLimit.middleware.js';
import {
  getPublicConfig,
  siteAssistantMessage,
  messageSchema,
} from '../controllers/siteAssistant.controller.js';

/**
 * Asistente del sitio — endpoints PÚBLICOS (sin auth) que alimentan el widget
 * flotante. La administración vive en /admin/site-assistant (solo admin).
 */
const router = Router();

router.get('/config', getPublicConfig);
router.post('/message', demoLimiter, validate(messageSchema), siteAssistantMessage);

export default router;
