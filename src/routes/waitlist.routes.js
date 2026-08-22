import { Router } from 'express';
import { validate } from '../middleware/validate.middleware.js';
import { joinWaitlist, joinSchema } from '../controllers/waitlist.controller.js';

/** Lista de espera de planes de pago — endpoint PÚBLICO (sin auth). */
const router = Router();

router.post('/', validate(joinSchema), joinWaitlist);

export default router;
