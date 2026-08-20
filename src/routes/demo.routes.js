import { Router } from 'express';
import { validate } from '../middleware/validate.middleware.js';
import { demoLimiter } from '../middleware/rateLimit.middleware.js';
import { demoMessage, demoMessageSchema } from '../controllers/demo.controller.js';

const router = Router();

// Público (sin auth): la demo que un visitante prueba antes de registrarse.
router.post('/message', demoLimiter, validate(demoMessageSchema), demoMessage);

export default router;
