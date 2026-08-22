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
import memberRoutes from './members.routes.js';
import conversationRoutes from './conversations.routes.js';

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
router.use('/billing', billingRoutes);
router.use('/management', managementRoutes);
router.use('/conversations', conversationRoutes);
router.use('/members', memberRoutes);
router.use('/admin', adminRoutes);

export default router;
