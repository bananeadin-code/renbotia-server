import { asyncHandler } from '../utils/asyncHandler.js';
import { Subscription } from '../models/Subscription.js';
import { ApiError } from '../utils/ApiError.js';
import { applyLazyReset, computeBalance } from '../services/token.service.js';

/**
 * Estado de la suscripción del negocio + balance de tokens calculado.
 * Aplica el reseteo mensual perezoso antes de responder.
 */
export const getMySubscription = asyncHandler(async (req, res) => {
  const subscription = await Subscription.findOne({ business: req.businessId }).populate('plan');
  if (!subscription) {
    throw ApiError.notFound('No hay suscripción para este negocio');
  }

  await applyLazyReset(subscription);
  const balance = computeBalance(subscription);

  res.json({
    success: true,
    data: {
      subscription: {
        id: subscription.id,
        status: subscription.status,
        plan: subscription.plan,
        pendingPlanKey: subscription.pendingPlanKey || '',
        currentPeriodStart: subscription.currentPeriodStart,
        renewalDate: subscription.renewalDate,
      },
      balance,
    },
  });
});
