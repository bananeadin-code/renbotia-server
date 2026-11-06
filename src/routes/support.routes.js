import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireBusiness } from '../middleware/tenant.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { contactLimiter } from '../middleware/rateLimit.middleware.js';
import { sendSupportMessage, supportMessageSchema } from '../controllers/support.controller.js';

/** Ayuda del panel: mensajes al equipo con el contexto de la cuenta (con sesión y límite anti-spam). */
const router = Router();

router.post('/message', requireAuth, requireBusiness, contactLimiter, validate(supportMessageSchema), sendSupportMessage);

export default router;
