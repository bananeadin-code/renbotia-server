import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { PLANS, CREDIT_PACKS } from '../config/constants.js';
import { env } from '../config/env.js';
import {
  createPaymentIntent,
  retrievePaymentIntent,
  createSetupIntent,
  retrievePaymentMethod,
  setDefaultPaymentMethod,
  detachPaymentMethod,
} from '../services/stripe.service.js';
import { ensureCustomer, ensureProfile } from '../services/billingProfile.service.js';
import { sendPurchaseReceipt } from '../services/email.service.js';
import { loadBusinessBundle } from '../services/business.service.js';
import { addExtraTokens, isPaidPlanKey, nextPeriodPlanKey } from '../services/token.service.js';
import { finalizeRenewal, renewalKeyFor, renewSubscription } from '../services/renewal.service.js';
import { logAudit } from '../services/audit.service.js';
import { addMonths } from '../utils/dates.js';
import { Business } from '../models/Business.js';
import { Subscription } from '../models/Subscription.js';
import { Plan } from '../models/Plan.js';
import { Payment } from '../models/Payment.js';

const findPlan = (key) => PLANS.find((p) => p.key === key);
const findPack = (key) => CREDIT_PACKS.find((p) => p.key === key);

export const changePlanSchema = z.object({ planKey: z.enum(['free', 'pro', 'elite']) });

// Crea un PaymentIntent para una compra (plan, paquete de créditos o el pago
// manual de una renovación vencida). El Free se activa en el onboarding.
export const createIntentSchema = z
  .object({
    kind: z.enum(['plan', 'credits', 'renewal']),
    planKey: z.enum(['pro', 'elite']).optional(),
    packKey: z.enum(CREDIT_PACKS.map((p) => p.key)).optional(),
    useSavedCard: z.boolean().optional(), // compatibilidad: siempre se usa la guardada
  })
  .refine(
    (d) => (d.kind === 'plan' ? Boolean(d.planKey) : d.kind === 'credits' ? Boolean(d.packKey) : true),
    { message: 'Falta planKey (plan) o packKey (créditos) según el tipo de compra' }
  );

const RENEWAL_LOCK_MS = 10 * 60 * 1000;

/**
 * POST /api/billing/intent
 * Cobro DENTRO del sitio con la TARJETA GUARDADA del negocio ("primero agrega
 * una tarjeta, luego compra", como Render). La misma tarjeta queda para las
 * renovaciones mensuales y la recarga automática.
 *  - plan: mejora a un plan más caro (se aplica al instante al confirmar).
 *  - credits: paquete de créditos.
 *  - renewal: pagar ahora una renovación vencida (p. ej. si el banco pidió 3DS).
 * El PaymentIntent se confirma on-session; si el banco pide autenticación, queda
 * en `requires_action` y el navegador la completa.
 */
export const createIntent = asyncHandler(async (req, res) => {
  // Seguridad de beta: con claves LIVE y el sitio en beta no se cobra nada.
  const liveKey = String(env.stripe.secretKey || '').startsWith('sk_live_');
  if (liveKey && env.betaMode) {
    throw new ApiError(403, 'Las compras están deshabilitadas mientras el sitio está en beta.', {
      code: 'BETA_MODE',
    });
  }

  const { kind } = req.body;
  const business = await Business.findOne({ owner: req.userId }).select('_id');
  if (!business) throw ApiError.notFound('Primero crea tu negocio para poder comprar.');

  // Tarjeta primero: sin tarjeta guardada no se inicia ningún cobro.
  const { profile, customerId } = await ensureCustomer(business._id, req.userId);
  if (!profile.paymentMethod?.id) {
    throw new ApiError(400, 'Agrega una tarjeta antes de comprar.', { code: 'CARD_REQUIRED' });
  }

  const sub = await Subscription.findOne({ business: business._id }).populate('plan');
  if (!sub) throw ApiError.notFound('No hay suscripción para este negocio');

  let amountMXN;
  let description;
  let metadata;

  if (kind === 'plan') {
    const plan = findPlan(req.body.planKey);
    if (!plan) throw ApiError.badRequest('Plan inválido');
    // Solo mejoras: bajar de plan o mantenerlo se programa para la renovación.
    const currentPrice = findPlan(sub.plan?.key)?.priceMXN ?? 0;
    if (plan.priceMXN <= currentPrice) {
      throw ApiError.badRequest('Para bajar o mantener tu plan usa "Cambiar plan"; aplica en tu renovación.');
    }
    amountMXN = plan.priceMXN;
    description = `Plan ${plan.name} — RenBotIA`;
    metadata = {
      type: 'plan',
      planKey: plan.key,
      userId: String(req.userId),
      businessId: String(business._id),
    };
  } else if (kind === 'credits') {
    const pack = findPack(req.body.packKey);
    if (!pack) throw ApiError.badRequest('Paquete inválido');
    amountMXN = pack.priceMXN;
    description = `${pack.name} — RenBotIA`;
    metadata = {
      type: 'credits',
      packKey: pack.key,
      userId: String(req.userId),
      businessId: String(business._id),
    };
  } else {
    // Renovación vencida pagada a mano.
    const targetKey = nextPeriodPlanKey(sub);
    const plan = findPlan(targetKey);
    if (sub.renewalDate.getTime() > Date.now() || !isPaidPlanKey(targetKey) || !plan) {
      throw ApiError.badRequest('No tienes una renovación pendiente de pago.');
    }
    // Candado: mientras este pago está en curso, el cobrador automático no
    // intenta cobrar el mismo periodo (evita cobrar dos veces).
    const now = new Date();
    const locked = await Subscription.findOneAndUpdate(
      {
        _id: sub._id,
        renewalDate: sub.renewalDate,
        $or: [{ renewalLockUntil: null }, { renewalLockUntil: { $lte: now } }],
      },
      { $set: { renewalLockUntil: new Date(now.getTime() + RENEWAL_LOCK_MS) } }
    );
    if (!locked) {
      throw new ApiError(409, 'Estamos procesando tu renovación. Espera un minuto y revisa de nuevo.', {
        code: 'RENEWAL_IN_PROGRESS',
      });
    }
    amountMXN = plan.priceMXN;
    description = `Renovación Plan ${plan.name} — RenBotIA`;
    metadata = {
      type: 'renewal',
      planKey: plan.key,
      userId: String(req.userId),
      businessId: String(business._id),
      subscriptionId: String(sub._id),
      dueDate: String(sub.renewalDate.getTime()),
      renewalKey: renewalKeyFor(sub),
    };
  }

  let pi;
  try {
    pi = await createPaymentIntent({
      amountMXN,
      customerId,
      description,
      metadata,
      paymentMethodId: profile.paymentMethod.id,
    });
  } catch (err) {
    if (kind === 'renewal') {
      await Subscription.updateOne({ _id: sub._id }, { $set: { renewalLockUntil: null } });
    }
    // Rechazo de la tarjeta al confirmar: mensaje claro para el usuario.
    if (err?.type === 'StripeCardError' || err?.code === 'card_declined') {
      throw new ApiError(402, err.message || 'Tu banco rechazó el cargo.', { code: 'CARD_DECLINED' });
    }
    throw err;
  }

  res.json({
    success: true,
    data: {
      paymentIntentId: pi.id,
      clientSecret: pi.client_secret,
      status: pi.status,
      publishableKey: env.stripe.publishableKey,
      amountMXN,
      description,
    },
  });
});

export const confirmSchema = z.object({
  paymentIntentId: z.string().min(10).max(255),
});

// Registra el pago ANTES de entregar: el índice único de stripeSessionId hace
// que, si llegan dos confirmaciones a la vez, solo una entregue. Devuelve null
// si este pago ya se había procesado.
async function claimPayment(doc) {
  try {
    return await Payment.create(doc);
  } catch (err) {
    if (err?.code === 11000) return null;
    throw err;
  }
}

/**
 * POST /api/billing/confirm
 * Se llama tras confirmar el pago en el navegador. Verifica en Stripe que el
 * PaymentIntent es de este usuario y está 'succeeded', y entonces entrega (plan,
 * créditos o renovación) UNA sola vez.
 */
export const confirmCheckout = asyncHandler(async (req, res) => {
  const { paymentIntentId } = req.body;

  const pi = await retrievePaymentIntent(paymentIntentId);

  // Seguridad: la metadata la pone el servidor al crear el pago; debe coincidir.
  if (!pi.metadata?.userId || pi.metadata.userId !== String(req.userId)) {
    throw ApiError.forbidden('Este pago no te pertenece');
  }
  if (pi.status !== 'succeeded') {
    throw new ApiError(402, 'El pago aún no se ha completado', {
      code: 'PAYMENT_NOT_COMPLETED',
      status: pi.status,
    });
  }

  const type = pi.metadata?.type;
  const business = await Business.findOne({ _id: pi.metadata.businessId, owner: req.userId });
  if (!business) throw ApiError.forbidden('Negocio inválido para esta compra');
  const amountMXN = pi.amount / 100;

  if (type === 'plan') {
    const plan = findPlan(pi.metadata.planKey);
    if (!plan) throw ApiError.badRequest('Plan inválido en el pago');

    const claim = await claimPayment({
      user: req.userId,
      business: business._id,
      type: 'plan',
      description: `Plan ${plan.name}`,
      amountMXN,
      planKey: plan.key,
      stripeSessionId: pi.id,
    });
    if (!claim) return res.json({ success: true, data: { alreadyProcessed: true, type } });

    let bundle;
    try {
      await upgradeSubscriptionPlan(business._id, plan.key);
      bundle = await loadBusinessBundle(business._id);
    } catch (err) {
      await Payment.deleteOne({ _id: claim._id }); // libera para reintentar
      throw err;
    }

    void logAudit({
      businessId: business._id,
      userId: req.userId,
      action: 'plan.upgrade',
      summary: `Mejoró al plan ${plan.name}.`,
      metadata: { planKey: plan.key, amountMXN },
    });
    void sendPurchaseReceipt({
      userId: req.userId,
      businessName: business.name,
      type: 'plan',
      description: `Plan ${plan.name}`,
      amountMXN,
      reference: pi.id,
    });
    return res.status(201).json({ success: true, data: { type: 'plan', bundle, upgraded: true } });
  }

  if (type === 'credits') {
    const pack = findPack(pi.metadata.packKey);
    if (!pack) throw ApiError.badRequest('Paquete inválido en el pago');

    const subscription = await Subscription.findOne({ business: business._id }).populate('plan');
    if (!subscription) throw ApiError.notFound('No hay suscripción para acreditar');

    const claim = await claimPayment({
      user: req.userId,
      business: business._id,
      type: 'credits',
      description: pack.name,
      amountMXN,
      tokens: pack.tokens,
      packKey: pack.key,
      stripeSessionId: pi.id,
    });
    if (!claim) return res.json({ success: true, data: { alreadyProcessed: true, type } });

    let balance;
    try {
      balance = await addExtraTokens(subscription, pack.tokens);
    } catch (err) {
      await Payment.deleteOne({ _id: claim._id });
      throw err;
    }

    void sendPurchaseReceipt({
      userId: req.userId,
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
      userId: req.userId,
      action: 'credits.purchase',
      summary: `Compró ${pack.name}.`,
      metadata: { packKey: pack.key, amountMXN, tokens: pack.tokens },
    });
    return res.json({ success: true, data: { type: 'credits', balance } });
  }

  if (type === 'renewal') {
    const sub = await Subscription.findOne({ _id: pi.metadata.subscriptionId, business: business._id });
    if (!sub) throw ApiError.notFound('No hay suscripción para renovar');
    const opened = await finalizeRenewal({
      subscriptionId: sub._id,
      dueDate: new Date(Number(pi.metadata.dueDate)),
      planKey: pi.metadata.planKey,
      paymentIntentId: pi.id,
      amountMXN,
      userId: req.userId,
    });
    await Subscription.updateOne({ _id: sub._id }, { $set: { renewalLockUntil: null } });
    return res.json({ success: true, data: { type: 'renewal', renewed: true, alreadyProcessed: !opened } });
  }

  throw ApiError.badRequest('Tipo de pago desconocido');
});

/**
 * GET /api/billing/payments — historial de pagos del negocio actual.
 */
export const listPayments = asyncHandler(async (req, res) => {
  const payments = await Payment.find({ business: req.businessId })
    .sort({ createdAt: -1 })
    .lean();
  res.json({ success: true, data: { payments } });
});

// Helper: recarga la suscripción del negocio con el plan poblado.
async function loadSub(businessId) {
  const sub = await Subscription.findOne({ business: businessId }).populate('plan');
  if (!sub) throw ApiError.notFound('No hay suscripción para este negocio');
  return sub;
}

/**
 * Aplica una mejora de plan de forma INMEDIATA sobre la suscripción existente:
 * cambia el plan, reinicia el periodo y el consumo del cupo (los créditos extra
 * comprados se conservan) y deja la suscripción activa. Se usa al confirmar el
 * pago de una mejora (Free/Pro → Pro/Elite).
 */
async function upgradeSubscriptionPlan(businessId, planKey) {
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
  sub.tokensUsedThisPeriod = 0; // arranca el nuevo cupo del plan mejorado
  sub.lowBalanceNotified = false;
  // Pagó: cualquier renovación vencida queda saldada por este nuevo periodo.
  sub.renewalAttempts = 0;
  sub.nextRenewalAttemptAt = null;
  sub.pastDueSince = null;
  sub.lastRenewalError = '';
  await sub.save();
  return sub;
}

// ¿El negocio tiene tarjeta guardada? (requisito para todo lo que se cobra).
async function hasSavedCard(businessId) {
  const profile = await ensureProfile(businessId);
  return Boolean(profile.paymentMethod?.id);
}

const CARD_FOR_RENEWAL = () =>
  new ApiError(400, 'Agrega una tarjeta en Facturación: tu plan se renueva con ella cada mes.', {
    code: 'CARD_REQUIRED',
  });

/**
 * POST /api/billing/cancel
 * Cancela la renovación (comportamiento tradicional): el plan NO se renueva,
 * pero el negocio conserva su tiempo y tokens hasta la fecha de renovación.
 * Al llegar esa fecha, baja automáticamente a Free (ver applyLazyReset).
 */
export const cancelSubscription = asyncHandler(async (req, res) => {
  const sub = await loadSub(req.businessId);
  sub.status = 'cancelada';
  sub.pendingPlanKey = ''; // una cancelación descarta un cambio programado
  await sub.save();
  void logAudit({
    businessId: req.businessId,
    userId: req.userId,
    action: 'plan.cancel',
    summary: 'Canceló la renovación del plan.',
  });
  res.json({
    success: true,
    message: 'Tu plan no se renovará. Conservas acceso hasta la fecha de renovación.',
    data: { status: sub.status, renewalDate: sub.renewalDate },
  });
});

/**
 * POST /api/billing/resume
 * Reactiva la renovación de un plan cancelado (antes de que termine el periodo).
 */
export const resumeSubscription = asyncHandler(async (req, res) => {
  const sub = await loadSub(req.businessId);
  if (sub.status !== 'cancelada') {
    throw ApiError.badRequest('La suscripción no está cancelada');
  }
  const resumeKey = sub.pendingPlanKey || sub.plan?.key;
  if (isPaidPlanKey(resumeKey) && !(await hasSavedCard(req.businessId))) throw CARD_FOR_RENEWAL();
  sub.status = 'activa';
  await sub.save();
  void logAudit({
    businessId: req.businessId,
    userId: req.userId,
    action: 'plan.resume',
    summary: 'Reactivó la renovación del plan.',
  });
  res.json({ success: true, message: 'Renovación reactivada.', data: { status: sub.status } });
});

/**
 * POST /api/billing/change-plan
 * Programa un cambio de plan para la PRÓXIMA renovación (tradicional): el plan
 * actual sigue hasta la fecha de renovación y a partir de ahí se renueva ya con
 * el nuevo plan. No cobra de inmediato: el cobro lo hace el cobrador de
 * renovaciones (services/renewal.service.js) con la tarjeta guardada.
 */
export const changePlan = asyncHandler(async (req, res) => {
  const targetKey = req.body.planKey;
  const plan = findPlan(targetKey);
  if (!plan) throw ApiError.badRequest('Plan inválido');

  const sub = await loadSub(req.businessId);
  const currentKey = sub.plan?.key;

  // Seguir en un plan de pago exige tarjeta guardada (se cobrará al renovar).
  if (isPaidPlanKey(targetKey) && !(await hasSavedCard(req.businessId))) throw CARD_FOR_RENEWAL();

  // Si elige su plan actual, se interpreta como "deshacer" el cambio programado.
  if (targetKey === currentKey) {
    sub.pendingPlanKey = '';
    if (sub.status === 'cancelada') sub.status = 'activa';
    await sub.save();
    return res.json({
      success: true,
      message: 'Se mantendrá tu plan actual.',
      data: { pendingPlanKey: '', status: sub.status },
    });
  }

  sub.pendingPlanKey = targetKey;
  if (sub.status === 'cancelada') sub.status = 'activa'; // cambiar implica seguir activo
  await sub.save();
  res.json({
    success: true,
    message: `Cambio programado a ${plan.name} en tu próxima renovación (${new Date(
      sub.renewalDate
    ).toLocaleDateString('es-MX')}).`,
    data: { pendingPlanKey: targetKey, status: sub.status },
  });
});

/* ─── Tarjeta guardada + recarga automática ──────────────────────────────── */

/**
 * GET /api/billing/config
 * Devuelve la clave PUBLICABLE de Stripe (no secreta) para inicializar Elements.
 */
export const getBillingConfig = asyncHandler(async (req, res) => {
  // paidPlansLive: los planes de pago solo se pueden COMPRAR cuando se cumplen
  // DOS condiciones: (1) hay claves live de Stripe (prefijo sk_live_) y (2) el
  // modo beta está apagado (BETA_MODE=false). Así se pueden dejar las claves de
  // producción CONFIGURADAS sin abrir cobros todavía; el día del lanzamiento
  // basta con poner BETA_MODE=false. Mientras, el sitio muestra Pro/Elite como
  // "Próximamente" con lista de espera.
  const hasLiveKey = String(env.stripe.secretKey || '').startsWith('sk_live_');
  res.json({
    success: true,
    data: {
      publishableKey: env.stripe.publishableKey,
      paidPlansLive: hasLiveKey && !env.betaMode,
    },
  });
});

/**
 * GET /api/billing/public-config — versión PÚBLICA (sin auth) para las páginas de
 * marketing (Precios): solo expone si los planes de pago ya se pueden comprar,
 * para no dejar "Próximamente" a los visitantes sin sesión. No revela secretos.
 */
export const getPublicBillingConfig = asyncHandler(async (req, res) => {
  const hasLiveKey = String(env.stripe.secretKey || '').startsWith('sk_live_');
  res.json({ success: true, data: { paidPlansLive: hasLiveKey && !env.betaMode } });
});

/**
 * POST /api/billing/setup-intent
 * Crea (o reutiliza) el Customer de Stripe y un SetupIntent para guardar una
 * tarjeta desde Elements. Devuelve el clientSecret que el navegador confirma.
 */
export const startSetupIntent = asyncHandler(async (req, res) => {
  const { customerId } = await ensureCustomer(req.businessId, req.userId);
  const { clientSecret } = await createSetupIntent(customerId);
  res.json({ success: true, data: { clientSecret } });
});

export const savePaymentMethodSchema = z.object({
  paymentMethodId: z.string().min(5, 'paymentMethodId inválido'),
});

/**
 * POST /api/billing/payment-method
 * Tras confirmar el SetupIntent en el cliente, guarda la tarjeta (solo display:
 * marca/últimos4/vencimiento) y la deja como método por defecto para off-session.
 */
export const savePaymentMethod = asyncHandler(async (req, res) => {
  const { profile, customerId } = await ensureCustomer(req.businessId, req.userId);
  const { customer, ...card } = await retrievePaymentMethod(req.body.paymentMethodId);
  // Seguridad: la tarjeta debe estar asociada al Customer de ESTE negocio (la
  // asocia el SetupIntent que creamos); no se acepta un id ajeno.
  if (!customer || customer !== customerId) {
    throw ApiError.forbidden('Esta tarjeta no pertenece a tu cuenta');
  }
  await setDefaultPaymentMethod(customerId, card.id);

  // Reemplazo: la tarjeta anterior se desasocia para no dejar métodos huérfanos.
  const previousId = profile.paymentMethod?.id;
  profile.paymentMethod = card;
  await profile.save();
  if (previousId && previousId !== card.id) {
    detachPaymentMethod(previousId).catch(() => {});
  }

  // Si tenía una renovación vencida, se reintenta YA con la tarjeta nueva.
  const sub = await Subscription.findOne({ business: req.businessId }).select('_id renewalDate status');
  let renewal = null;
  if (sub && sub.renewalDate.getTime() <= Date.now()) {
    await Subscription.updateOne({ _id: sub._id }, { $set: { nextRenewalAttemptAt: null } });
    renewal = await renewSubscription(sub._id).catch(() => null);
  }
  res.json({ success: true, data: { paymentMethod: card, autoRecharge: profile.autoRecharge, renewal } });
});

/**
 * GET /api/billing/payment-method
 * Estado de la tarjeta guardada + configuración de recarga automática.
 */
export const getPaymentMethod = asyncHandler(async (req, res) => {
  const profile = await ensureProfile(req.businessId);
  res.json({
    success: true,
    data: { paymentMethod: profile.paymentMethod || null, autoRecharge: profile.autoRecharge },
  });
});

/**
 * DELETE /api/billing/payment-method
 * Quita la tarjeta guardada (la desasocia en Stripe) y desactiva la auto-recarga.
 */
export const deletePaymentMethod = asyncHandler(async (req, res) => {
  const profile = await ensureProfile(req.businessId);
  // Un plan de pago que se va a renovar necesita tarjeta: se puede CAMBIAR por
  // otra, pero no quitar sin antes cancelar la renovación o bajar a Free.
  const sub = await Subscription.findOne({ business: req.businessId }).populate('plan');
  if (sub && isPaidPlanKey(nextPeriodPlanKey(sub))) {
    throw new ApiError(409, 'Tu plan se renueva con esta tarjeta. Cámbiala por otra o cancela la renovación antes de quitarla.', {
      code: 'CARD_IN_USE',
    });
  }
  if (profile.paymentMethod?.id) {
    await detachPaymentMethod(profile.paymentMethod.id);
  }
  profile.paymentMethod = null;
  profile.autoRecharge.enabled = false; // sin tarjeta no puede auto-recargar
  await profile.save();
  res.json({ success: true, data: { paymentMethod: null, autoRecharge: profile.autoRecharge } });
});

export const autoRechargeSchema = z.object({
  enabled: z.boolean(),
  packKey: z.enum(CREDIT_PACKS.map((p) => p.key)).optional(),
  threshold: z.number().int().min(0).max(5_000_000).optional(),
});

/**
 * PUT /api/billing/auto-recharge
 * Configura la recarga automática (activar, pack a comprar, umbral de saldo).
 * Exige tener una tarjeta guardada para poder activarla.
 */
export const updateAutoRecharge = asyncHandler(async (req, res) => {
  const profile = await ensureProfile(req.businessId);
  const { enabled, packKey, threshold } = req.body;

  if (enabled && !profile.paymentMethod?.id) {
    throw ApiError.badRequest('Agrega una tarjeta antes de activar la recarga automática');
  }
  if (enabled && !packKey) {
    throw ApiError.badRequest('Elige un paquete para la recarga automática');
  }

  profile.autoRecharge.enabled = enabled;
  if (packKey !== undefined) profile.autoRecharge.packKey = packKey;
  if (threshold !== undefined) profile.autoRecharge.threshold = threshold;
  await profile.save();

  res.json({ success: true, data: { autoRecharge: profile.autoRecharge } });
});
