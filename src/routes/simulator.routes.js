import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireBusiness } from '../middleware/tenant.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { simulatorLimiter } from '../middleware/rateLimit.middleware.js';
import { sendMessage, sendMessageSchema } from '../controllers/simulator.controller.js';

const router = Router();

router.use(requireAuth, requireBusiness);

// simulatorLimiter protege el endpoint que llama a Claude (coste real de API).
router.post('/message', simulatorLimiter, validate(sendMessageSchema), sendMessage);

export default router;
