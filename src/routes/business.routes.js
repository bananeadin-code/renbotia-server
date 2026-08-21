import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireBusiness } from '../middleware/tenant.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as business from '../controllers/business.controller.js';

const router = Router();

// Lista de proyectos accesibles (propio + colaboración) para el switcher. Solo
// requiere auth: NO requireBusiness (no depende del negocio activo).
router.get('/projects', requireAuth, business.listMyProjects);

// El resto requiere usuario autenticado + negocio activo (aislamiento tenant)
router.use(requireAuth, requireBusiness);

router.get('/me', business.getMyBusiness);
router.patch('/me', validate(business.updateBusinessSchema), business.updateMyBusiness);
router.get('/audit', business.getAuditLog); // bitácora de auditoría del negocio

// Verificación de propiedad del número de WhatsApp (OTP; SMS mockeado por ahora).
router.post(
  '/whatsapp/send-code',
  validate(business.sendWhatsappCodeSchema),
  business.sendWhatsappCode
);
router.post('/whatsapp/verify', validate(business.verifyWhatsappSchema), business.verifyWhatsapp);

export default router;
