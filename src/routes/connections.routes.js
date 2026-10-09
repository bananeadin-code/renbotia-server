import { Router } from 'express';
import { requireRecentAuth } from '../middleware/stepUp.middleware.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireBusiness, requirePermission } from '../middleware/tenant.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as connections from '../controllers/connections.controller.js';

const router = Router();
router.use(requireAuth, requireBusiness);

// Estado y config lo puede ver cualquier miembro del negocio.
router.get('/', connections.getConnections);

// Conectar/desconectar y ajustar canales: dueño o colaborador con permiso de conexiones.
router.post(
  '/whatsapp',
  requirePermission('connections'),
  requireRecentAuth,
  validate(connections.connectSchema),
  connections.connectWhatsApp
);
router.post('/whatsapp/disconnect', requirePermission('connections'), requireRecentAuth, connections.disconnectWhatsApp);

// Perfil de WhatsApp Business (ver: cualquier miembro; editar: dueño).
router.get('/whatsapp/profile', connections.getWhatsappProfile);
router.put(
  '/whatsapp/profile',
  requirePermission('connections'),
  validate(connections.updateWhatsappProfileSchema),
  connections.updateWhatsappProfile
);

// Facebook Messenger: conectar/elegir Página/desconectar (solo dueño).
router.post(
  '/messenger',
  requirePermission('connections'),
  requireRecentAuth,
  validate(connections.connectMessengerSchema),
  connections.connectMessenger
);
router.post(
  '/messenger/select',
  requirePermission('connections'),
  validate(connections.selectMessengerPageSchema),
  connections.selectMessengerPage
);
router.post('/messenger/disconnect', requirePermission('connections'), requireRecentAuth, connections.disconnectMessenger);

// Ajustes por canal (pausa, preguntas iniciales, saludo): dueño.
router.put(
  '/settings',
  requirePermission('connections'),
  validate(connections.channelSettingsSchema),
  connections.updateChannelSettings
);

// Instagram DMs (cuenta profesional ligada a una Página): acción del DUEÑO.
router.post(
  '/instagram',
  requirePermission('connections'),
  requireRecentAuth,
  validate(connections.connectMessengerSchema),
  connections.connectInstagram
);
router.post(
  '/instagram/select',
  requirePermission('connections'),
  validate(connections.selectInstagramSchema),
  connections.selectInstagramAccount
);
router.post('/instagram/disconnect', requirePermission('connections'), requireRecentAuth, connections.disconnectInstagram);

// Plantillas de la WABA (ver: cualquier miembro; crear: dueño).
router.get('/whatsapp/templates', connections.listWhatsappTemplates);
router.post(
  '/whatsapp/templates',
  requirePermission('connections'),
  validate(connections.createTemplateSchema),
  connections.createWhatsappTemplate
);

export default router;
