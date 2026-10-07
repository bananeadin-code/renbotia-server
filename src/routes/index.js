import { Router } from 'express';
import mongoose from 'mongoose';
import authRoutes from './auth.routes.js';
import onboardingRoutes from './onboarding.routes.js';
import planRoutes from './plan.routes.js';
import businessRoutes from './business.routes.js';
import subscriptionRoutes from './subscription.routes.js';
import botConfigRoutes from './botConfig.routes.js';
import usageRoutes from './usage.routes.js';
import chatRoutes from './chat.routes.js';
import simulatorRoutes from './simulator.routes.js';
import billingRoutes from './billing.routes.js';
import managementRoutes from './management.routes.js';
import adminRoutes from './admin.routes.js';
import demoRoutes from './demo.routes.js';
import siteAssistantRoutes from './siteAssistant.routes.js';
import waitlistRoutes from './waitlist.routes.js';
import contactRoutes from './contact.routes.js';
import memberRoutes from './members.routes.js';
import conversationRoutes from './conversations.routes.js';
import connectionRoutes from './connections.routes.js';
import widgetRoutes from './widget.routes.js';
import mediaRoutes from './media.routes.js';
import learningRoutes from './learning.routes.js';
import importRoutes from './import.routes.js';
import referralRoutes from './referral.routes.js';
import ownerControlRoutes from './ownerControl.routes.js';
import { runFollowUps } from '../services/followUp.service.js';

/**
 * Monta todas las rutas de la API bajo /api.
 */
const router = Router();

router.get('/health', (req, res) => {
  // readyState 1 = conectado. Reporta el estado de cada componente para la
  // página pública de status.
  const dbUp = mongoose.connection?.readyState === 1;
  res.json({
    success: true,
    message: 'API operativa',
    timestamp: new Date().toISOString(),
    components: {
      api: 'ok',
      database: dbUp ? 'ok' : 'down',
    },
  });
});

// Disparo externo del seguimiento automático (Render Cron u otro programador),
// por si el proceso web estuvo dormido. Protegido con CRON_SECRET; sin él, 404.
router.post('/internal/followups', async (req, res, next) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.get('x-cron-secret') !== secret) return res.sendStatus(404);
  try {
    res.json({ success: true, data: await runFollowUps() });
  } catch (err) {
    next(err);
  }
});

router.use('/auth', authRoutes);
router.use('/onboarding', onboardingRoutes);
router.use('/plans', planRoutes);
router.use('/business', businessRoutes);
router.use('/subscription', subscriptionRoutes);
router.use('/botconfig', botConfigRoutes);
router.use('/usage', usageRoutes);
router.use('/chats', chatRoutes);
router.use('/simulator', simulatorRoutes);
router.use('/demo', demoRoutes); // público (sin auth): demo de la landing
router.use('/site-assistant', siteAssistantRoutes); // público: asistente del sitio (widget)
router.use('/waitlist', waitlistRoutes); // público: lista de espera de planes de pago
router.use('/contact', contactRoutes); // público: formulario de contacto
router.use('/billing', billingRoutes);
router.use('/management', managementRoutes);
router.use('/conversations', conversationRoutes);
router.use('/connections', connectionRoutes);
router.use('/learning', learningRoutes); // Aprende de ti
router.use('/owner-control', ownerControlRoutes); // manejar el bot desde el WhatsApp del dueño
router.use('/referrals', referralRoutes); // invita y gana
router.use('/import', importRoutes); // entrenar desde chats, sitio o texto
router.use('/media', mediaRoutes); // público: imágenes del bot por URL (Instagram)
router.use('/widget', widgetRoutes); // panel + público (chat web incrustable)
router.use('/members', memberRoutes);
router.use('/admin', adminRoutes);

export default router;
