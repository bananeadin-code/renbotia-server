import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireAdmin } from '../middleware/role.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { listAllBusinesses } from '../controllers/admin.controller.js';
import {
  getAdminConfig,
  updateAdminConfig,
  updateSchema as siteAssistantUpdateSchema,
} from '../controllers/siteAssistant.controller.js';
import { listWaitlist } from '../controllers/waitlist.controller.js';

const router = Router();

// Solo rol admin. NOTA: no usa requireBusiness — el admin ve todos los negocios.
router.use(requireAuth, requireAdmin);

router.get('/businesses', listAllBusinesses);

// Configuración del asistente IA del sitio (widget de soporte/guía).
router.get('/site-assistant', getAdminConfig);
router.put('/site-assistant', validate(siteAssistantUpdateSchema), updateAdminConfig);

// Lista de espera de los planes de pago (interesados).
router.get('/waitlist', listWaitlist);

export default router;
