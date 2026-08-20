import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireBusiness } from '../middleware/tenant.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as botConfig from '../controllers/botConfig.controller.js';

const router = Router();

router.use(requireAuth, requireBusiness);

router.get('/', botConfig.getBotConfig);
router.put('/', validate(botConfig.updateBotConfigSchema), botConfig.updateBotConfig);

export default router;
