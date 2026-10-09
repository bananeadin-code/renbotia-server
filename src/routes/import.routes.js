import { Router } from 'express';
import { requireBusiness, requireAccess } from '../middleware/tenant.middleware.js';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/auth.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { Business } from '../models/Business.js';
import { Subscription } from '../models/Subscription.js';
import '../models/Plan.js';
import { importTraining, importSchema, IMPORT_LIMITS } from '../controllers/import.controller.js';

const router = Router();

/**
 * Plan del usuario para la importación. Sin requireBusiness: también se usa en el
 * registro inicial (aún no hay negocio), y ahí cuenta como Free.
 */
const resolveImportPlan = asyncHandler(async (req, res, next) => {
  const sc = req.sessionContext;
  const business =
    (sc?.kind === 'owner' || sc?.kind === 'member') && sc.business
      ? { _id: sc.business }
      : await Business.findOne({ owner: req.userId }).select('_id').lean();
  const sub = business ? await Subscription.findOne({ business: business._id }).populate('plan', 'key').lean() : null;
  req.importPlan = sub?.plan?.key || 'free';
  next();
});

// Cada análisis llama a Claude con mucho texto: límite diario por usuario y plan.
const importLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: (req) => (IMPORT_LIMITS[req.importPlan] || IMPORT_LIMITS.free).perDay,
  // Por persona y por negocio: lo que analiza en un proyecto no gasta el cupo del otro.
  keyGenerator: (req) => `${req.userId || req.ip}:${req.sessionContext?.business || 'own'}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Ya usaste tus análisis de hoy. Intenta mañana o mejora tu plan para analizar más.',
  },
});

// Dentro de un proyecto donde colabora: hace falta "entrenamiento: editar".
const requireTrainingInProject = (req, res, next) => {
  if (req.sessionContext?.kind !== 'member') return next();
  return requireBusiness(req, res, (err) => (err ? next(err) : requireAccess('training', 'edit')(req, res, next)));
};

router.post('/', requireAuth, requireTrainingInProject, resolveImportPlan, importLimiter, validate(importSchema), importTraining);

export default router;
