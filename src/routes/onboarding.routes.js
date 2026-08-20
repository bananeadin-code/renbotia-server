import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as onboarding from '../controllers/onboarding.controller.js';

const router = Router();

// Requiere usuario autenticado, pero NO requireBusiness (aún no existe).
router.use(requireAuth);

router.get('/status', onboarding.getOnboardingStatus);
router.post('/', validate(onboarding.onboardingSchema), onboarding.completeOnboarding);

export default router;
