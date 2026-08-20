import { Subscription } from '../models/Subscription.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

/**
 * Exige que el negocio tenga un plan concreto. Debe ir después de requireBusiness.
 * Responde 403 con code PLAN_REQUIRED para que el frontend muestre el upsell.
 *
 *   router.use(requireAuth, requireBusiness, requirePlan('elite'));
 */
export function requirePlan(...allowedKeys) {
  return asyncHandler(async (req, res, next) => {
    const sub = await Subscription.findOne({ business: req.businessId }).populate('plan', 'key');
    const planKey = sub?.plan?.key || 'free';
    if (!allowedKeys.includes(planKey)) {
      throw new ApiError(403, 'Esta función es exclusiva del plan Elite', {
        code: 'PLAN_REQUIRED',
        requiredPlans: allowedKeys,
        currentPlan: planKey,
      });
    }
    req.planKey = planKey;
    next();
  });
}

export const requireElite = requirePlan('elite');
