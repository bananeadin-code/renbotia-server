import { PLANS, CREDIT_PACKS } from '../config/constants.js';
import { Business } from '../models/Business.js';
import { Subscription } from '../models/Subscription.js';
import { Plan } from '../models/Plan.js';
import { Payment } from '../models/Payment.js';
import { ApiError } from '../utils/ApiError.js';
import { addMonths } from '../utils/dates.js';
import { logger } from '../utils/logger.js';
import { addExtraTokens } from './token.service.js';
import { finalizeRenewal } from './renewal.service.js';
import { sendPurchaseReceipt } from './email.service.js';
import { logAudit } from './audit.service.js';
import { qualifyReferral } from './referral.service.js';
import { getStripe } from './stripe.service.js';
import { alertOps } from './alert.service.js';

/**
 * Entrega de compras (plan, créditos o renovación pagada a mano) a partir de un
 * PaymentIntent de Stripe ya cobrado. UNA sola función para los tres caminos:
 *  1) Justo después del cobro, en el servidor (no depende del navegador).
 *  2) Cuando el navegador confirma (POST /billing/confirm).
 *  3) El conciliador: cada pocos minutos busca en Stripe pagos cobrados que no
 *     se entregaron (pestaña cerrada, red caída, verificación del banco 3DS).
 * Es idempotente: Payment.stripeSessionId es único, así nunca se entrega dos veces.
 */

const findPlan = (key) => PLANS.find((p) => p.key === key);
const findPack = (key) => CREDIT_PACKS.find((p) => p.key === key);
const RECONCILE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** Registra el pago; null si ya estaba registrado (otro camino ya lo entregó). */
async function claimPayment(doc) {
  try {
    return await Payment.create(doc);
  } catch (err) {
    if (err?.code === 11000) return null;
    throw err;
  }
}

/**
 * Mejora de plan pagada: cambia el plan, reinicia el periodo y el consumo del
 * cupo (los créditos extra comprados se conservan) y deja la suscripción activa.
 */
export async function upgradeSubscriptionPlan(businessId, planKey) {
  const plan = await Plan.findOne({ key: planKey, isActive: true });
  if (!plan) throw ApiError.badRequest(`Plan inválido: ${planKey}`);
  const sub = await Subscription.findOne({ business: businessId });
  if (!sub) throw ApiError.notFound('No hay suscripción para este negocio');
  const now = new Date();
  sub.plan = plan._id;
  sub.status = 'activa';
  sub.pendingPlanKey = '';
  sub.currentPeriodStart = now;
  sub.renewalDate = addMonths(now, 1);
  sub.tokensUsedThisPeriod = 0;
  sub.lowBalanceNotified = false;
  // Pagó: cualquier renovación vencida queda saldada por este nuevo periodo.
  sub.renewalAttempts = 0;
  sub.nextRenewalAttemptAt = null;
  sub.pastDueSince = null;
  sub.lastRenewalError = '';
  await sub.save();
  return sub;
}

/**
 * Entrega lo pagado en un PaymentIntent. Devuelve
 * { applied, alreadyProcessed, type, upgraded?, balance? } o { applied:false, reason }.
 */
export async function fulfillPaymentIntent(pi) {
  if (!pi || pi.status !== 'succeeded') return { applied: false, reason: 'no_cobrado' };
  const m = pi.metadata || {};
  if (!['plan', 'credits', 'renewal'].includes(m.type) || !m.businessId || !m.userId) {
    return { applied: false, reason: 'no_es_de_renbotia' };
  }
  const business = await Business.findOne({ _id: m.businessId, owner: m.userId });
  if (!business) return { applied: false, reason: 'negocio_no_encontrado' };
  const amountMXN = pi.amount / 100;

  if (m.type === 'plan') {
    const plan = findPlan(m.planKey);
    if (!plan) return { applied: false, reason: 'plan_invalido' };
    const claim = await claimPayment({
      user: m.userId,
      business: business._id,
      type: 'plan',
      description: `Plan ${plan.name}`,
      amountMXN,
      planKey: plan.key,
      stripeSessionId: pi.id,
    });
    if (!claim) return { applied: false, alreadyProcessed: true, type: 'plan', upgraded: true };
    try {
      await upgradeSubscriptionPlan(business._id, plan.key);
    } catch (err) {
      await Payment.deleteOne({ _id: claim._id }); // libera para reintentar
      throw err;
    }
    void logAudit({
      businessId: business._id,
      userId: m.userId,
      action: 'plan.upgrade',
      summary: `Mejoró al plan ${plan.name}.`,
      metadata: { planKey: plan.key, amountMXN },
    });
    void sendPurchaseReceipt({ userId: m.userId, businessName: business.name, type: 'plan', description: `Plan ${plan.name}`, amountMXN, reference: pi.id });
    void qualifyReferral(m.userId);
    return { applied: true, type: 'plan', upgraded: true };
  }

  if (m.type === 'credits') {
    const pack = findPack(m.packKey);
    if (!pack) return { applied: false, reason: 'paquete_invalido' };
    const subscription = await Subscription.findOne({ business: business._id }).populate('plan');
    if (!subscription) return { applied: false, reason: 'sin_suscripcion' };
    const claim = await claimPayment({
      user: m.userId,
      business: business._id,
      type: 'credits',
      description: pack.name,
      amountMXN,
      tokens: pack.tokens,
      packKey: pack.key,
      stripeSessionId: pi.id,
    });
    if (!claim) return { applied: false, alreadyProcessed: true, type: 'credits' };
    let balance;
    try {
      balance = await addExtraTokens(subscription, pack.tokens);
    } catch (err) {
      await Payment.deleteOne({ _id: claim._id });
      throw err;
    }
    void sendPurchaseReceipt({
      userId: m.userId,
      businessName: business.name,
      type: 'credits',
      description: pack.name,
      amountMXN,
      tokens: pack.tokens,
      reference: pi.id,
      availableAfter: balance.available,
    });
    void logAudit({
      businessId: business._id,
      userId: m.userId,
      action: 'credits.purchase',
      summary: `Compró ${pack.name}.`,
      metadata: { packKey: pack.key, amountMXN, tokens: pack.tokens },
    });
    void qualifyReferral(m.userId);
    return { applied: true, type: 'credits', balance };
  }

  // Renovación vencida pagada a mano.
  const sub = await Subscription.findOne({ _id: m.subscriptionId, business: business._id });
  if (!sub) return { applied: false, reason: 'sin_suscripcion' };
  const opened = await finalizeRenewal({
    subscriptionId: sub._id,
    dueDate: new Date(Number(m.dueDate)),
    planKey: m.planKey,
    paymentIntentId: pi.id,
    amountMXN,
    userId: m.userId,
  });
  await Subscription.updateOne({ _id: sub._id }, { $set: { renewalLockUntil: null } });
  return { applied: Boolean(opened), alreadyProcessed: !opened, type: 'renewal', renewed: true };
}

/* ── Conciliador: pagos cobrados que no se entregaron ──────────────────────── */

let deps = { list: (params) => getStripe().paymentIntents.list(params) };
export function __setFulfillmentTestHooks(h) {
  deps = { list: (params) => getStripe().paymentIntents.list(params), ...(h || {}) };
}

/** ¿Este PaymentIntent ya quedó registrado? (compra o renovación) */
async function alreadyRecorded(pi) {
  const ids = [pi.id, `renewpi_${pi.id}`];
  return Boolean(await Payment.exists({ stripeSessionId: { $in: ids } }));
}

let running = false;
export async function reconcilePayments({ now = Date.now() } = {}) {
  if (running) return { skipped: true };
  if (!String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_')) return { skipped: true };
  running = true;
  const fixed = [];
  try {
    let startingAfter;
    for (let page = 0; page < 10; page++) {
      const res = await deps.list({
        created: { gte: Math.floor((now - RECONCILE_WINDOW_MS) / 1000) },
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      for (const pi of res.data || []) {
        if (pi.status !== 'succeeded' || !['plan', 'credits', 'renewal'].includes(pi.metadata?.type)) continue;
        // Renovaciones automáticas (sin dueDate): las concilia el propio cobrador
        // con su renewalKey. Aquí solo las renovaciones pagadas a mano.
        if (pi.metadata?.type === 'renewal' && !pi.metadata?.dueDate) continue;
        if (await alreadyRecorded(pi)) continue;
        try {
          const r = await fulfillPaymentIntent(pi);
          if (r.applied) fixed.push({ id: pi.id, type: r.type });
        } catch (err) {
          logger.error(`Conciliación: no se pudo entregar ${pi.id}: ${err.message}`);
        }
      }
      if (!res.has_more || !res.data?.length) break;
      startingAfter = res.data[res.data.length - 1].id;
    }
    if (fixed.length) {
      logger.warn(`Conciliación: se entregaron ${fixed.length} pago(s) cobrados sin entregar: ${fixed.map((f) => f.id).join(', ')}`);
      alertOps({
        kind: 'billing.reconciled',
        message: `El conciliador entregó ${fixed.length} pago(s) cobrados sin entregar`,
        detail: fixed.map((f) => `${f.type} ${f.id}`).join(', '),
      });
    }
    return { fixed };
  } finally {
    running = false;
  }
}

export function startPaymentReconciler() {
  if (process.env.RECONCILE_ENABLED === 'false') return;
  const run = () => reconcilePayments().catch((err) => logger.warn(`Conciliación: ${err.message}`));
  setTimeout(run, 60 * 1000).unref?.(); // una pasada al arrancar
  const timer = setInterval(run, 10 * 60 * 1000);
  timer.unref?.();
  logger.info('Conciliación de pagos: revisión cada 10 min.');
}
