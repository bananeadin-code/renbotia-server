import { Router } from 'express';
import { validate } from '../middleware/validate.middleware.js';
import { contactLimiter } from '../middleware/rateLimit.middleware.js';
import { submitContact, contactSchema } from '../controllers/contact.controller.js';

/** Formulario de contacto — endpoint PÚBLICO (sin auth), con rate limit anti-spam. */
const router = Router();

router.post('/', contactLimiter, validate(contactSchema), submitContact);

export default router;
