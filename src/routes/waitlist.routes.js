import { Router } from 'express';
import { validate } from '../middleware/validate.middleware.js';
import { contactLimiter } from '../middleware/rateLimit.middleware.js';
import { joinWaitlist, joinSchema } from '../controllers/waitlist.controller.js';

/** Lista de espera de planes de pago — endpoint PÚBLICO (sin auth). */
const router = Router();

// Público: tope por IP para que un bot no llene la lista (y la base).
router.post('/', contactLimiter, validate(joinSchema), joinWaitlist);

export default router;
