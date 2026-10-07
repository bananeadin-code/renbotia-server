import { asyncHandler } from '../utils/asyncHandler.js';
import { Subscription } from '../models/Subscription.js';
import { ApiError } from '../utils/ApiError.js';
import { applyLazyReset, computeBalance, nextPeriodPlanKey, isPaidPlanKey } from '../services/token.service.js';
import { GRACE_DAYS } from '../services/renewal.service.js';
import { PLANS } from '../config/constants.js';

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
  const nextPlanKey = nextPeriodPlanKey(subscription);

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
        // Renovación con cobro: qué plan sigue, cuánto se cobrará y si hay un
        // pago pendiente (vencida) con su fecha límite antes de bajar a Free.
        nextPlanKey,
        renewalAmountMXN: isPaidPlanKey(nextPlanKey)
          ? PLANS.find((p) => p.key === nextPlanKey)?.priceMXN ?? 0
          : 0,
        renewalDue: subscription.renewalDate.getTime() <= Date.now() && isPaidPlanKey(nextPlanKey),
        pastDueSince: subscription.pastDueSince || null,
        graceEndsAt: subscription.pastDueSince
          ? new Date(subscription.pastDueSince.getTime() + GRACE_DAYS * 24 * 3600 * 1000)
          : null,
        lastRenewalError: subscription.lastRenewalError || '',
      },
      balance,
    },
  });
});
