import { Router } from 'express';
import { validate } from '../middleware/validate.middleware.js';
import { demoLimiter, demoProfileLimiter, demoDailyBudget, demoProfileDailyBudget } from '../middleware/rateLimit.middleware.js';
import { demoMessage, demoMessageSchema, demoProfile, demoProfileSchema } from '../controllers/demo.controller.js';

const router = Router();

// Público (sin auth): la demo que un visitante prueba antes de registrarse.
router.post('/message', demoLimiter, validate(demoMessageSchema), demoDailyBudget, demoMessage);
// "Pruébalo con tu negocio": arma un bot de demo con el sitio o la descripción.
router.post('/profile', demoProfileLimiter, validate(demoProfileSchema), demoProfileDailyBudget, demoProfile);

export default router;
