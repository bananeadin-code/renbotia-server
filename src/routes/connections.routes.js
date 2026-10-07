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

// Perfil de WhatsApp Business (ver: cualquier miembro; editar: dueño).
router.get('/whatsapp/profile', connections.getWhatsappProfile);
router.put(
  '/whatsapp/profile',
  requireBusinessRole('owner'),
  validate(connections.updateWhatsappProfileSchema),
  connections.updateWhatsappProfile
);

// Facebook Messenger: conectar/elegir Página/desconectar (solo dueño).
router.post(
  '/messenger',
  requireBusinessRole('owner'),
  validate(connections.connectMessengerSchema),
  connections.connectMessenger
);
router.post(
  '/messenger/select',
  requireBusinessRole('owner'),
  validate(connections.selectMessengerPageSchema),
  connections.selectMessengerPage
);
router.post('/messenger/disconnect', requireBusinessRole('owner'), connections.disconnectMessenger);

// Ajustes por canal (pausa, preguntas iniciales, saludo): dueño.
router.put(
  '/settings',
  requireBusinessRole('owner'),
  validate(connections.channelSettingsSchema),
  connections.updateChannelSettings
);

// Instagram DMs (cuenta profesional ligada a una Página): acción del DUEÑO.
router.post(
  '/instagram',
  requireBusinessRole('owner'),
  validate(connections.connectMessengerSchema),
  connections.connectInstagram
);
router.post(
  '/instagram/select',
  requireBusinessRole('owner'),
  validate(connections.selectInstagramSchema),
  connections.selectInstagramAccount
);
router.post('/instagram/disconnect', requireBusinessRole('owner'), connections.disconnectInstagram);

// Plantillas de la WABA (ver: cualquier miembro; crear: dueño).
router.get('/whatsapp/templates', connections.listWhatsappTemplates);
router.post(
  '/whatsapp/templates',
  requireBusinessRole('owner'),
  validate(connections.createTemplateSchema),
  connections.createWhatsappTemplate
);

export default router;
