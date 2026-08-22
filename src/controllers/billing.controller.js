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
import { provisionBusiness, loadBusinessBundle } from '../services/business.service.js';
import { addExtraTokens } from '../services/token.service.js';
import { logAudit } from '../services/audit.service.js';
import { addMonths } from '../utils/dates.js';
import { Business } from '../models/Business.js';
import { Subscription } from '../models/Subscription.js';
import { Plan } from '../models/Plan.js';
import { Payment } from '../models/Payment.js';

const findPlan = (key) => PLANS.find((p) => p.key === key);
const findPack = (key) => CREDIT_PACKS.find((p) => p.key === key);

export const changePlanSchema = z.object({ planKey: z.enum(['free', 'pro', 'elite']) });

// Crea un PaymentIntent embebido para una compra (plan o paquete de créditos).
// El Free se activa directo (onboarding), no pasa por aquí.
export const createIntentSchema = z
  .object({
    kind: z.enum(['plan', 'credits']),
    planKey: z.enum(['pro', 'elite']).optional(),
    packKey: z.enum(CREDIT_PACKS.map((p) => p.key)).optional(),
    useSavedCard: z.boolean().optional(),
  })
  .refine((d) => (d.kind === 'plan' ? Boolean(d.planKey) : Boolean(d.packKey)), {
    message: 'Falta planKey (plan) o packKey (créditos) según el tipo de compra',
  });

/**
 * POST /api/billing/intent
 * Crea un PaymentIntent para pagar DENTRO del sitio (Stripe Elements, sin
 * redirect). Sirve para:
 *  - Plan: onboarding (aún sin negocio; se crea al confirmar) o mejora de plan
 *    (ya tiene negocio; se aplica al instante al confirmar).
 *  - Créditos: compra de un paquete para el negocio actual.
 * Si `useSavedCard` es true y hay tarjeta guardada, el PI se confirma de una vez
 * (on-session); el navegador solo completa 3DS si Stripe lo pide.
 */
export const createIntent = asyncHandler(async (req, res) => {
  const { kind, useSavedCard } = req.body;

  let amountMXN;
  let description;
  let metadata;
  let customerId;
  let savedCardBusinessId; // negocio del que tomar la tarjeta guardada (si aplica)

  if (kind === 'plan') {
    const plan = findPlan(req.body.planKey);
    if (!plan) throw ApiError.badRequest('Plan inválido');

    // Si ya tiene negocio, es una mejora y habilitamos su Customer (tarjeta
    // guardada). En el onboarding aún no hay negocio: pago sin customer.
    const business = await Business.findOne({ owner: req.userId }).select('_id');
    if (business) {
      const { customerId: cid } = await ensureCustomer(business._id, req.userId);
      customerId = cid;
      savedCardBusinessId = business._id;
    }
    amountMXN = plan.priceMXN;
    description = `Plan ${plan.name} — RenBotIA`;
    metadata = {
      type: 'plan',
      planKey: plan.key,
      userId: String(req.userId),
      context: business ? 'upgrade' : 'onboarding',
    };
  } else {
    // Créditos: se compran para el negocio del usuario.
    const pack = findPack(req.body.packKey);
    if (!pack) throw ApiError.badRequest('Paquete inválido');
    const business = await Business.findOne({ owner: req.userId }).select('_id');
    if (!business) throw ApiError.notFound('No tienes un negocio para comprar créditos');
    const { customerId: cid } = await ensureCustomer(business._id, req.userId);
    customerId = cid;
    savedCardBusinessId = business._id;
    amountMXN = pack.priceMXN;
    description = `${pack.name} — RenBotIA`;
    metadata = {
      type: 'credits',
      packKey: pack.key,
      userId: String(req.userId),
      businessId: String(business._id),
    };
  }

  // Tarjeta guardada (cobro inmediato con el método por defecto del negocio).
  let paymentMethodId;
  if (useSavedCard) {
    if (!savedCardBusinessId) {
      throw ApiError.badRequest('No hay un negocio con tarjeta guardada para este pago');
    }
    const profile = await ensureProfile(savedCardBusinessId);
    if (!profile.paymentMethod?.id) {
      throw ApiError.badRequest('No tienes una tarjeta guardada');
    }
    paymentMethodId = profile.paymentMethod.id;
    if (!customerId) customerId = profile.stripeCustomerId;
  }

  const pi = await createPaymentIntent({
    amountMXN,
    customerId,
    description,
    metadata,
    paymentMethodId,
  });

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

// Datos de onboarding que el cliente reenvía al confirmar el pago del plan.
const onboardingPayload = z
  .object({
    business: z.object({
      // Opcional: datos del negocio se pueden completar luego en el panel.
      name: z.string().max(80).optional().default(''),
      industry: z.enum(['legal', 'contable', 'consultoria', 'agencia', 'otro']).optional(),
      industryOther: z.string().max(60).optional(),
      whatsappNumber: z.string().max(30).optional(),
    }),
    botConfig: z.any().optional(),
  })
  .optional();

export const confirmSchema = z.object({
  paymentIntentId: z.string().min(10),
  onboarding: onboardingPayload,
});

/**
 * POST /api/billing/confirm
 * Se llama tras confirmar el pago embebido en el navegador. Verifica en Stripe
 * que el PaymentIntent está 'succeeded' y recién entonces activa el plan (crea
 * el negocio) o acredita los tokens. Idempotente vía Payment.stripeSessionId
 * (guarda el id del PaymentIntent). Al entregar, envía el comprobante por email.
 */
export const confirmCheckout = asyncHandler(async (req, res) => {
  const { paymentIntentId, onboarding } = req.body;

  const pi = await retrievePaymentIntent(paymentIntentId);

  // Seguridad: el pago debe pertenecer a este usuario.
  if (pi.metadata?.userId && pi.metadata.userId !== String(req.userId)) {
    throw ApiError.forbidden('Este pago no te pertenece');
  }
  if (pi.status !== 'succeeded') {
    throw new ApiError(402, 'El pago aún no se ha completado', {
      code: 'PAYMENT_NOT_COMPLETED',
      status: pi.status,
    });
  }

  // Idempotencia: si ya procesamos este pago, no repetimos la entrega.
  const already = await Payment.findOne({ stripeSessionId: pi.id });
  if (already) {
    return res.json({
      success: true,
      data: { alreadyProcessed: true, type: already.type },
    });
  }

  const type = pi.metadata?.type;

  if (type === 'plan') {
    const plan = findPlan(pi.metadata.planKey);
    if (!plan) throw ApiError.badRequest('Plan inválido en el pago');

    // Si el usuario YA tiene negocio, es una mejora de plan: se aplica al
    // instante (nuevo límite de tokens, ventajas del plan, sin esperar a la
    // renovación). Si no, es el onboarding y se crea el negocio.
    const existing = await Business.findOne({ owner: req.userId });
    let bundle;
    let businessId;
    if (existing) {
      await upgradeSubscriptionPlan(existing._id, plan.key);
      businessId = existing._id;
      bundle = await loadBusinessBundle(existing._id);
    } else {
      bundle = await provisionBusiness({
        owner: req.userId,
        planKey: plan.key,
        business: onboarding?.business || { name: 'Mi negocio' },
        botConfig: onboarding?.botConfig || {},
        stripeSessionId: pi.id,
      });
      businessId = bundle.business._id;
    }

    await Payment.create({
      user: req.userId,
      business: businessId,
      type: 'plan',
      description: `Plan ${plan.name}`,
      amountMXN: plan.priceMXN,
      planKey: plan.key,
      stripeSessionId: pi.id,
    });

    void logAudit({
      businessId,
      userId: req.userId,
      action: existing ? 'plan.upgrade' : 'plan.activate',
      summary: existing ? `Mejoró al plan ${plan.name}.` : `Activó el plan ${plan.name}.`,
      metadata: { planKey: plan.key, amountMXN: plan.priceMXN },
    });

    // Comprobante por email (fail-open, no bloquea la respuesta).
    void sendPurchaseReceipt({
      userId: req.userId,
      businessName: bundle?.business?.name,
      type: 'plan',
      description: `Plan ${plan.name}`,
      amountMXN: plan.priceMXN,
      reference: pi.id,
    });

    return res
      .status(201)
      .json({ success: true, data: { type: 'plan', bundle, upgraded: Boolean(existing) } });
  }

  if (type === 'credits') {
    const pack = findPack(pi.metadata.packKey);
    if (!pack) throw ApiError.badRequest('Paquete inválido en el pago');

    // Verifica que el negocio del pago pertenece al usuario.
    const business = await Business.findOne({
      _id: pi.metadata.businessId,
      owner: req.userId,
    });
    if (!business) throw ApiError.forbidden('Negocio inválido para esta compra');

    const subscription = await Subscription.findOne({ business: business._id }).populate('plan');
    if (!subscription) throw ApiError.notFound('No hay suscripción para acreditar');

    const balance = await addExtraTokens(subscription, pack.tokens);

    await Payment.create({
      user: req.userId,
      business: business._id,
      type: 'credits',
      description: pack.name,
      amountMXN: pack.priceMXN,
      tokens: pack.tokens,
      packKey: pack.key,
      stripeSessionId: pi.id,
    });

    void sendPurchaseReceipt({
      userId: req.userId,
      businessName: business.name,
      type: 'credits',
      description: pack.name,
      amountMXN: pack.priceMXN,
      tokens: pack.tokens,
      reference: pi.id,
      availableAfter: balance.available,
    });

    void logAudit({
      businessId: business._id,
      userId: req.userId,
      action: 'credits.purchase',
      summary: `Compró ${pack.name}.`,
      metadata: { packKey: pack.key, amountMXN: pack.priceMXN, tokens: pack.tokens },
    });

    return res.json({ success: true, data: { type: 'credits', balance } });
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
  await sub.save();
  return sub;
}

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
 * el nuevo plan. No cobra de inmediato (el modelo de renovación es simulado).
 */
export const changePlan = asyncHandler(async (req, res) => {
  const targetKey = req.body.planKey;
  const plan = findPlan(targetKey);
  if (!plan) throw ApiError.badRequest('Plan inválido');

  const sub = await loadSub(req.businessId);
  const currentKey = sub.plan?.key;

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
  // paidPlansLive: los planes de pago solo se pueden COMPRAR con claves live de
  // Stripe. Se detecta solo por el prefijo sk_live_ → al poner las claves de
  // producción se activa automáticamente (sin tocar código). Mientras, el sitio
  // muestra Pro/Elite como "Próximamente" con lista de espera.
  res.json({
    success: true,
    data: {
      publishableKey: env.stripe.publishableKey,
      paidPlansLive: String(env.stripe.secretKey || '').startsWith('sk_live_'),
    },
  });
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
  const card = await retrievePaymentMethod(req.body.paymentMethodId);
  await setDefaultPaymentMethod(customerId, card.id);

  profile.paymentMethod = card;
  await profile.save();
  res.json({ success: true, data: { paymentMethod: card, autoRecharge: profile.autoRecharge } });
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
