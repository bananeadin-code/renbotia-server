import { Router } from 'express';
import cors from 'cors';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireBusiness, requirePermission } from '../middleware/tenant.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { widgetLimiter } from '../middleware/rateLimit.middleware.js';
import * as widget from '../controllers/widget.controller.js';

const router = Router();

// ── Público ──
// La config la lee el snippet desde el sitio del cliente (otro dominio): CORS
// abierto y sin credenciales. Sobrescribe el CORS global (solo para esta ruta).
const openCors = cors({ origin: '*', credentials: false, methods: ['GET'] });
router.options('/public/:key', openCors);
router.get('/public/:key', openCors, widget.publicConfig);
// El chat corre dentro del iframe de renbotia.com: same-origin.
router.post('/public/:key/message', widgetLimiter, validate(widget.widgetMessageSchema), widget.publicMessage);
router.get('/public/:key/messages', widget.publicThread);

// ── Panel ──
router.get('/', requireAuth, requireBusiness, widget.getWidget);
router.put(
  '/',
  requireAuth,
  requireBusiness,
  requirePermission('connections'),
  validate(widget.updateWidgetSchema),
  widget.updateWidget
);

export default router;
