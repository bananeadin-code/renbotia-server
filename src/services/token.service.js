import { addMonths } from '../utils/dates.js';
import { Plan } from '../models/Plan.js';
import { Subscription } from '../models/Subscription.js';
import { PLANS } from '../config/constants.js';

/**
 * Lógica de la billetera de tokens.
 *
 * La `subscription` debe venir con `plan` poblado (populate('plan')) para poder
 * leer plan.monthlyTokenLimit.
 */

/** ¿El plan `key` cuesta dinero? (Pro/Elite). */
export function isPaidPlanKey(key) {
  return (PLANS.find((p) => p.key === key)?.priceMXN ?? 0) > 0;
}

/**
 * Plan con el que arranca el SIGUIENTE periodo:
 *  - cancelada → Free (al terminar el periodo baja a Free).
 *  - cambio programado (pendingPlanKey) → ese plan (incluye el fin del mes de
 *    regalo por referidos, que programa 'free').
 *  - si no, el plan actual.
 */
export function nextPeriodPlanKey(subscription) {
  if (subscription.status === 'cancelada') return 'free';
  if (subscription.pendingPlanKey) return subscription.pendingPlanKey;
  return subscription.plan?.key || 'free';
}

/**
 * Reseteo mensual PEREZOSO, SOLO para periodos que siguen GRATIS (Free, plan
 * cancelado o fin del regalo de referidos): avanza el periodo y resetea el
 * consumo sin cobrar nada.
 *
 * Si el siguiente periodo es de PAGO, aquí no se toca: lo renueva el cobrador
 * (services/renewal.service.js) solo cuando el cobro a la tarjeta se confirma.
 * Mientras tanto el negocio conserva su plan con lo que le quede del periodo
 * anterior (no recibe cupo nuevo sin pagar).
 *
 * Los extraTokens (créditos comprados) NO se tocan: se acumulan.
 */
export async function applyLazyReset(subscription) {
  if (!subscription.renewalDate) return subscription;

  const now = Date.now();
  if (subscription.renewalDate.getTime() > now) return subscription;

  const targetKey = nextPeriodPlanKey(subscription);
  if (isPaidPlanKey(targetKey)) return subscription; // lo renueva el cobrador

  let periodStart = subscription.renewalDate;
  let renewal = subscription.renewalDate;
  while (renewal.getTime() <= now) {
    periodStart = renewal;
    renewal = addMonths(renewal, 1);
  }

  let newPlan = null;
  if (targetKey !== subscription.plan?.key) {
    newPlan = await Plan.findOne({ key: targetKey });
  }

  // Escritura condicionada a la fecha de renovación leída: si otro proceso ya
  // renovó este periodo, no se pisa.
  const set = {
    status: 'activa',
    pendingPlanKey: '',
    currentPeriodStart: periodStart,
    renewalDate: renewal,
    tokensUsedThisPeriod: 0,
    lowBalanceNotified: false,
    renewalAttempts: 0,
    nextRenewalAttemptAt: null,
    pastDueSince: null,
    lastRenewalError: '',
  };
  if (newPlan) set.plan = newPlan._id;
  await Subscription.updateOne(
    { _id: subscription._id, renewalDate: subscription.renewalDate },
    { $set: set }
  );

  // Refleja el cambio en el documento en memoria sin volver a guardarlo.
  for (const [k, v] of Object.entries(set)) {
    if (k === 'plan') continue;
    subscription.set(k, v);
    subscription.unmarkModified(k);
  }
  if (newPlan) {
    subscription.plan = newPlan;
    subscription.unmarkModified('plan');
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
  const extraTokens = Math.max(0, subscription.extraTokens);

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

// Relee los contadores de la billetera tras una escritura atómica y los copia
// al documento en memoria sin marcarlos como modificados (un save() posterior
// no debe pisar el valor real con uno viejo).
async function syncWallet(subscription) {
  const fresh = await Subscription.findById(subscription._id)
    .select('tokensUsedThisPeriod extraTokens lowBalanceNotified')
    .lean();
  if (!fresh) return;
  for (const k of ['tokensUsedThisPeriod', 'extraTokens', 'lowBalanceNotified']) {
    subscription.set(k, fresh[k]);
    subscription.unmarkModified(k);
  }
}

/**
 * Descuenta `amount` tokens: primero del cupo del plan, el resto de extraTokens.
 * Escritura ATÓMICA en la base (dos mensajes simultáneos no se pisan, y una
 * renovación que reinicia el cupo a mitad de una respuesta no se pierde).
 * Devuelve el balance resultante.
 */
export async function deductTokens(subscription, amount) {
  if (subscription.isModified()) await subscription.save();

  const planLimit = subscription.plan?.monthlyTokenLimit ?? 0;
  const amt = Math.max(0, Math.round(amount || 0));
  await Subscription.updateOne({ _id: subscription._id }, [
    {
      $set: {
        _fromPlan: {
          $min: [amt, { $max: [0, { $subtract: [planLimit, '$tokensUsedThisPeriod'] }] }],
        },
      },
    },
    {
      $set: {
        tokensUsedThisPeriod: { $add: ['$tokensUsedThisPeriod', '$_fromPlan'] },
        extraTokens: {
          $max: [0, { $subtract: ['$extraTokens', { $subtract: [amt, '$_fromPlan'] }] }],
        },
      },
    },
    { $unset: '_fromPlan' },
  ]);
  await syncWallet(subscription);
  return computeBalance(subscription);
}

/**
 * Suma créditos comprados a la billetera (compra de paquete de tokens). Atómico.
 */
export async function addExtraTokens(subscription, amount) {
  if (subscription.isModified()) await subscription.save();
  await Subscription.updateOne(
    { _id: subscription._id },
    { $inc: { extraTokens: Math.max(0, Math.round(amount || 0)) }, $set: { lowBalanceNotified: false } }
  );
  await syncWallet(subscription);
  return computeBalance(subscription);
}
