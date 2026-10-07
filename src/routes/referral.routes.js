import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { referralSummary } from '../services/referral.service.js';

const router = Router();

/** GET /api/referrals — enlace de invitación y avance hacia el próximo mes de Pro. */
router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await referralSummary(req.userId) });
  })
);

export default router;
