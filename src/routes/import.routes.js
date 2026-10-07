import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/auth.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { importTraining, importSchema } from '../controllers/import.controller.js';

const router = Router();

// Sin requireBusiness: también se usa en el registro inicial (aún no hay negocio).
// Cada análisis llama a Claude con mucho texto: límite por usuario.
const importLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 12,
  keyGenerator: (req) => String(req.userId || req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Ya analizaste varios materiales hoy. Intenta de nuevo mañana.' },
});

router.post('/', requireAuth, importLimiter, validate(importSchema), importTraining);

export default router;
