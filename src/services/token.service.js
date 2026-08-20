import { addMonths } from '../utils/dates.js';
import { Plan } from '../models/Plan.js';

/**
 * Lógica de la billetera de tokens.
 *
 * La `subscription` debe venir con `plan` poblado (populate('plan')) para poder
 * leer plan.monthlyTokenLimit.
 */

/**
 * Reseteo mensual PEREZOSO: si la fecha de renovación ya pasó, avanza el periodo
 * y resetea el consumo. Además aplica la gestión de plan (tradicional):
 *  - Si hay un cambio de plan programado (pendingPlanKey), se activa ahora.
 *  - Si la suscripción está 'cancelada', baja automáticamente a Free.
 * Los extraTokens (créditos comprados) NO se tocan: se acumulan.
 */
export async function applyLazyReset(subscription) {
  if (!subscription.renewalDate) return subscription;

  const now = Date.now();
  if (subscription.renewalDate.getTime() > now) return subscription;

  let periodStart = subscription.renewalDate;
  let renewal = subscription.renewalDate;
  while (renewal.getTime() <= now) {
    periodStart = renewal;
    renewal = addMonths(renewal, 1);
  }

  // Determina el plan del nuevo periodo.
  let targetKey = null;
  if (subscription.status === 'cancelada') {
    targetKey = 'free'; // cancelar = al terminar el periodo, baja a Free
  } else if (subscription.pendingPlanKey) {
    targetKey = subscription.pendingPlanKey; // cambio de plan programado
  }

  if (targetKey && targetKey !== subscription.plan?.key) {
    const newPlan = await Plan.findOne({ key: targetKey });
    if (newPlan) {
      subscription.plan = newPlan._id;
      subscription._pendingPopulatedPlan = newPlan; // para re-poblar abajo
    }
  }

  subscription.status = 'activa';
  subscription.pendingPlanKey = '';
  subscription.currentPeriodStart = periodStart;
  subscription.renewalDate = renewal;
  subscription.tokensUsedThisPeriod = 0;
  subscription.lowBalanceNotified = false; // nuevo periodo: se puede volver a avisar
  await subscription.save();

  // Re-poblar plan si cambió (para que computeBalance lea el nuevo límite).
  if (subscription._pendingPopulatedPlan) {
    subscription.plan = subscription._pendingPopulatedPlan;
    delete subscription._pendingPopulatedPlan;
  }

  return subscription;
}

/**
 * Calcula el balance disponible a partir de la suscripción (con plan poblado).
 */
export function computeBalance(subscription) {
  const planLimit = subscription.plan?.monthlyTokenLimit ?? 0;
  const planUsed = subscription.tokensUsedThisPeriod;
  const planRemaining = Math.max(0, planLimit - planUsed);
  const extraTokens = subscription.extraTokens;

  return {
    planLimit,
    planUsed,
    planRemaining,
    extraTokens,
    available: planRemaining + extraTokens,
  };
}

/**
 * ¿Tiene al menos `amount` tokens disponibles?
 */
export function hasBalance(subscription, amount = 1) {
  return computeBalance(subscription).available >= amount;
}

/**
 * Descuenta `amount` tokens: primero del cupo del plan, el resto de extraTokens.
 * Persiste la suscripción. Devuelve el balance resultante.
 *
 * Nota: el llamador debe verificar hasBalance() antes; aquí se hace clamp para
 * no dejar valores negativos aunque se pida de más.
 */
export async function deductTokens(subscription, amount) {
  const planLimit = subscription.plan?.monthlyTokenLimit ?? 0;
  const planRemaining = Math.max(0, planLimit - subscription.tokensUsedThisPeriod);

  const fromPlan = Math.min(amount, planRemaining);
  subscription.tokensUsedThisPeriod += fromPlan;

  const rest = amount - fromPlan;
  if (rest > 0) {
    const fromExtra = Math.min(rest, subscription.extraTokens);
    subscription.extraTokens -= fromExtra;
  }

  await subscription.save();
  return computeBalance(subscription);
}

/**
 * Suma créditos comprados a la billetera (compra de paquete de tokens).
 */
export async function addExtraTokens(subscription, amount) {
  subscription.extraTokens += amount;
  subscription.lowBalanceNotified = false; // recargó: se puede volver a avisar si baja
  await subscription.save();
  return computeBalance(subscription);
}
