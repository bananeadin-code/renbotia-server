import { teamUnlockedFor } from '../utils/teamAccess.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { Subscription } from '../models/Subscription.js';
import { ApiError } from '../utils/ApiError.js';
import { applyLazyReset, computeBalance, nextPeriodPlanKey, planKeyAfterTerm, isPaidPlanKey } from '../services/token.service.js';
import { GRACE_DAYS } from '../services/renewal.service.js';
import {
  insidePaidTerm,
  nextCycle,
  nextChargeDate,
  renewalPrice,
  guaranteeActive,
  orientationIncluded,
  hasActiveAnnual,
} from '../services/pricing.service.js';
import { Business } from '../models/Business.js';
import { Lead } from '../models/Lead.js';
import { env } from '../config/env.js';

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
  const inTerm = insidePaidTerm(subscription);
  // Próximo COBRO real: en anual, al terminar el año (con el plan/ciclo programado).
  const chargeKey = inTerm ? planKeyAfterTerm(subscription) : nextPlanKey;
  const chargeCycle = inTerm ? subscription.pendingCycle || 'anual' : nextCycle(subscription);
  const charges = isPaidPlanKey(chargeKey) && !subscription.complimentary;

  // Sesión de orientación: gratis para cualquier cuenta, una por negocio; se oculta
  // cuando el equipo la marca como realizada.
  const business = await Business.findById(req.businessId).select('owner').lean();
  const lead = business ? await Lead.findOne({ user: business.owner }).select('orientationAt').lean() : null;

  res.json({
    success: true,
    data: {
      subscription: {
        id: subscription.id,
        status: subscription.status,
        plan: subscription.plan,
        // Puede invitar colaboradores (Pro/Elite o excepción de soporte).
        teamUnlocked: await teamUnlockedFor(req.businessId, subscription.plan?.key),
        pendingPlanKey: subscription.pendingPlanKey || '',
        currentPeriodStart: subscription.currentPeriodStart,
        renewalDate: subscription.renewalDate,
        // Renovación con cobro: qué plan sigue, cuánto se cobrará y si hay un
        // pago pendiente (vencida) con su fecha límite antes de bajar a Free.
        nextPlanKey,
        complimentary: Boolean(subscription.complimentary),
        renewalAmountMXN: charges ? renewalPrice(subscription, chargeKey, chargeCycle) : 0,
        nextChargeAt: charges ? nextChargeDate(subscription) : null,
        nextChargeCycle: charges ? chargeCycle : '',
        renewalDue: subscription.renewalDate.getTime() <= Date.now() && isPaidPlanKey(nextPlanKey) && !inTerm,
        // Plan anual.
        billingCycle: subscription.billingCycle || 'mensual',
        annualActive: hasActiveAnnual(subscription),
        termEndsAt: subscription.termEndsAt || null,
        pendingCycle: subscription.pendingCycle || '',
        founder: Boolean(subscription.founder),
        guaranteeEndsAt: guaranteeActive(subscription) ? subscription.guaranteeEndsAt : null,
        orientation: {
          included: orientationIncluded(subscription),
          done: Boolean(lead?.orientationAt),
          bookingUrl: env.funnel.bookingUrl || '',
        },
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
