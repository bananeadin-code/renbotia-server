import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireBusiness, requireBusinessRole } from '../middleware/tenant.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as connections from '../controllers/connections.controller.js';

const router = Router();
router.use(requireAuth, requireBusiness);

// Estado y config lo puede ver cualquier miembro del negocio.
router.get('/', connections.getConnections);

// Conectar/desconectar WhatsApp es acción del DUEÑO (identidad del negocio).
router.post(
  '/whatsapp',
  requireBusinessRole('owner'),
  validate(connections.connectSchema),
  connections.connectWhatsApp
);
router.post('/whatsapp/disconnect', requireBusinessRole('owner'), connections.disconnectWhatsApp);

export default router;
