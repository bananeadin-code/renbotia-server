import { Subscription } from '../models/Subscription.js';
import { Plan } from '../models/Plan.js';
import { Business } from '../models/Business.js';
import { BillingProfile } from '../models/BillingProfile.js';
import { Payment } from '../models/Payment.js';
import { PLANS } from '../config/constants.js';
import { env } from '../config/env.js';
import { addMonths } from '../utils/dates.js';
import { logger } from '../utils/logger.js';
import { chargeOffSession, findSucceededIntent } from './stripe.service.js';
import { applyLazyReset, isPaidPlanKey, nextPeriodPlanKey } from './token.service.js';
import { sendPurchaseReceipt, sendRenewalNoticeEmail } from './email.service.js';
import { logAudit } from './audit.service.js';

/**
 * Renovación mensual CON COBRO de los planes de pago (Pro/Elite).
 *
 * Flujo de cada suscripción vencida cuyo siguiente periodo es de pago:
 *  1. Se toma un candado atómico (dos procesos nunca cobran la misma renovación).
 *  2. Reconciliación: si en Stripe ya hay un cobro exitoso de ESTE periodo (el
 *     proceso se cayó tras cobrar), se usa ese y no se cobra otra vez.
 *  3. Cobro off-session a la tarjeta guardada con clave de idempotencia.
 *  4. Éxito → registra el pago y abre el nuevo periodo (escritura condicionada a
 *     la fecha de renovación, para no avanzar dos veces).
 *  5. Fallo → estado 'vencida', se avisa por correo y se reintenta cada 24 h
 *     durante GRACE_DAYS. Al terminar la gracia sin pago, baja a Free (conserva
 *     sus créditos comprados y su configuración).
 *
 * Durante la gracia el negocio conserva su plan pero NO recibe cupo nuevo: solo
 * lo que le quedaba del periodo anterior más sus créditos extra.
 */

export const GRACE_DAYS = 3;
const RETRY_HOURS = 24;
const LOCK_MINUTES = 10;
const REMINDER_DAYS = 3;
const DAY = 24 * 3600 * 1000;

const planInfo = (key) => PLANS.find((p) => p.key === key);

// Identificador estable del periodo a cobrar (sub + fecha de vencimiento).
export const renewalKeyFor = (sub, dueDate = sub.renewalDate) =>
  `${sub._id}_${new Date(dueDate).getTime()}`;

const billingUrl = () => `${env.publicUrl.replace(/\/$/, '')}/dashboard/facturacion`;

async function ownerOf(businessId) {
  return Business.findById(businessId).select('owner name').lean();
}

/** Suelta el candado de cobro. */
async function releaseLock(subId) {
  await Subscription.updateOne({ _id: subId }, { $set: { renewalLockUntil: null } });
}

/**
 * Abre el nuevo periodo pagado. Idempotente: el Payment es único por cobro y la
 * suscripción solo avanza si su renewalDate sigue siendo la del periodo cobrado.
 * Lo usan el cobrador automático y el pago manual desde Facturación.
 *
 * @returns {Promise<boolean>} true si este llamado abrió el periodo.
 */
export async function finalizeRenewal({ subscriptionId, dueDate, planKey, paymentIntentId, amountMXN, userId }) {
  const sub = await Subscription.findById(subscriptionId);
  if (!sub) return false;
  const plan = await Plan.findOne({ key: planKey });
  const info = planInfo(planKey);
  if (!plan || !info) throw new Error(`Plan inválido en renovación: ${planKey}`);
  const biz = await ownerOf(sub.business);

  // 1) Registro del pago (único por PaymentIntent).
  try {
    await Payment.create({
      user: userId || biz?.owner,
      business: sub.business,
      type: 'plan',
      renewal: true,
      description: `Renovación Plan ${info.name}`,
      amountMXN: amountMXN ?? info.priceMXN,
      planKey,
      stripeSessionId: `renewpi_${paymentIntentId}`,
    });
  } catch (err) {
    if (err?.code !== 11000) throw err; // 11000 = ya registrado (reintento)
  }

  // 2) Nuevo periodo, anclado al vencimiento (o a hoy si el cobro llega muy
  //    tarde, p. ej. tras varios días sin pago).
  const due = new Date(dueDate);
  const now = new Date();
  const start = now.getTime() - due.getTime() > (GRACE_DAYS + 1) * DAY ? now : due;
  let next = addMonths(start, 1);
  while (next.getTime() <= now.getTime()) next = addMonths(next, 1);

  const res = await Subscription.updateOne(
    { _id: sub._id, renewalDate: due },
    {
      $set: {
        plan: plan._id,
        status: 'activa',
        pendingPlanKey: '',
        currentPeriodStart: start,
        renewalDate: next,
        tokensUsedThisPeriod: 0,
        lowBalanceNotified: false,
        renewalAttempts: 0,
        nextRenewalAttemptAt: null,
        pastDueSince: null,
        lastRenewalError: '',
        renewalLockUntil: null,
      },
    }
  );
  if (!res.modifiedCount) return false; // otro proceso ya abrió este periodo

  void sendPurchaseReceipt({
    userId: userId || biz?.owner,
    businessName: biz?.name,
    type: 'plan',
    description: `Renovación Plan ${info.name}`,
    amountMXN: amountMXN ?? info.priceMXN,
    reference: paymentIntentId,
  });
  void logAudit({
    businessId: sub.business,
    userId: userId || biz?.owner,
    action: 'plan.renew',
    summary: `Se renovó el plan ${info.name}.`,
    metadata: { planKey, amountMXN: amountMXN ?? info.priceMXN },
  });
  logger.info(`Renovación OK: plan ${planKey} para negocio ${sub.business}`);
  return true;
}

/** Baja a Free al terminar la gracia sin pago (conserva créditos extra). */
async function downgradeToFree(sub, reason) {
  const free = await Plan.findOne({ key: 'free' });
  if (!free) throw new Error('No existe el plan Free');
  const now = new Date();
  const prevKey = nextPeriodPlanKey(sub);
  const res = await Subscription.updateOne(
    { _id: sub._id, renewalDate: sub.renewalDate },
    {
      $set: {
        plan: free._id,
        status: 'activa',
        pendingPlanKey: '',
        currentPeriodStart: now,
        renewalDate: addMonths(now, 1),
        tokensUsedThisPeriod: 0,
        lowBalanceNotified: false,
        renewalAttempts: 0,
        nextRenewalAttemptAt: null,
        pastDueSince: null,
        lastRenewalError: reason || '',
        renewalLockUntil: null,
      },
    }
  );
  if (!res.modifiedCount) return;
  const biz = await ownerOf(sub.business);
  void sendRenewalNoticeEmail({
    kind: 'downgraded',
    userId: biz?.owner,
    businessName: biz?.name,
    planName: planInfo(prevKey)?.name,
    url: billingUrl(),
  });
  void logAudit({
    businessId: sub.business,
    userId: biz?.owner,
    action: 'plan.downgrade_unpaid',
    summary: `Bajó a Free por falta de pago del plan ${planInfo(prevKey)?.name || prevKey}.`,
    metadata: { reason },
  });
  logger.warn(`Renovación: negocio ${sub.business} bajó a Free por falta de pago (${reason}).`);
}

/** Registra un intento fallido: gracia + reintento, o baja a Free si ya venció. */
async function markFailed(sub, reason, card) {
  const now = new Date();
  const pastDueSince = sub.pastDueSince || now;
  const graceEnds = new Date(pastDueSince.getTime() + GRACE_DAYS * DAY);

  if (now >= graceEnds) {
    await downgradeToFree(sub, reason);
    return;
  }

  const firstFailure = !sub.pastDueSince;
  const nextAttempt = new Date(Math.min(now.getTime() + RETRY_HOURS * DAY / 24, graceEnds.getTime()));
  await Subscription.updateOne(
    { _id: sub._id, renewalDate: sub.renewalDate },
    {
      $set: {
        status: 'vencida',
        pastDueSince,
        nextRenewalAttemptAt: nextAttempt,
        lastRenewalError: reason,
        renewalLockUntil: null,
      },
    }
  );

  // Aviso por correo solo en el PRIMER fallo (no en cada reintento).
  if (firstFailure) {
    const biz = await ownerOf(sub.business);
    const info = planInfo(nextPeriodPlanKey(sub));
    void sendRenewalNoticeEmail({
      kind: 'failed',
      reason,
      userId: biz?.owner,
      businessName: biz?.name,
      planName: info?.name,
      amountMXN: info?.priceMXN,
      card,
      graceEnds,
      url: billingUrl(),
    });
  }
  logger.warn(`Renovación: cobro fallido para negocio ${sub.business} (${reason}).`);
}

/**
 * Procesa UNA suscripción vencida. Seguro ante concurrencia y reintentos.
 * @returns {Promise<'renewed'|'free'|'failed'|'skipped'|'downgraded'>}
 */
export async function renewSubscription(subId, now = new Date()) {
  // 1) Candado atómico.
  const sub = await Subscription.findOneAndUpdate(
    {
      _id: subId,
      renewalDate: { $lte: now },
      $or: [{ renewalLockUntil: null }, { renewalLockUntil: { $lte: now } }],
    },
    { $set: { renewalLockUntil: new Date(now.getTime() + LOCK_MINUTES * 60 * 1000) } },
    { new: true }
  ).populate('plan');
  if (!sub) return 'skipped';

  try {
    const targetKey = nextPeriodPlanKey(sub);

    // Periodo gratis (Free, cancelado, fin del regalo): sin cobro.
    if (!isPaidPlanKey(targetKey)) {
      await applyLazyReset(sub);
      return 'free';
    }

    const info = planInfo(targetKey);
    const dueDate = sub.renewalDate;
    const renewalKey = renewalKeyFor(sub, dueDate);
    const biz = await ownerOf(sub.business);
    const profile = await BillingProfile.findOne({ business: sub.business });

    // 2) Reconciliación: ¿ya se cobró este periodo?
    if (profile?.stripeCustomerId) {
      const paid = await findSucceededIntent({
        customerId: profile.stripeCustomerId,
        key: 'renewalKey',
        value: renewalKey,
        sinceDate: new Date(dueDate.getTime() - 2 * DAY),
      });
      if (paid) {
        await finalizeRenewal({
          subscriptionId: sub._id,
          dueDate,
          planKey: targetKey,
          paymentIntentId: paid.id,
          amountMXN: paid.amount / 100,
          userId: biz?.owner,
        });
        return 'renewed';
      }
    }

    // Sin tarjeta guardada: no se puede cobrar.
    if (!profile?.paymentMethod?.id || !profile?.stripeCustomerId) {
      await markFailed(sub, 'no_card', null);
      return 'failed';
    }

    // 3) Cobro con idempotencia por periodo + intento.
    const attempt = (sub.renewalAttempts || 0) + 1;
    await Subscription.updateOne({ _id: sub._id }, { $set: { renewalAttempts: attempt } });
    sub.renewalAttempts = attempt;

    const card = { brand: profile.paymentMethod.brand, last4: profile.paymentMethod.last4 };
    let pi;
    try {
      pi = await chargeOffSession({
        customerId: profile.stripeCustomerId,
        paymentMethodId: profile.paymentMethod.id,
        amountMXN: info.priceMXN,
        description: `Renovación Plan ${info.name} — RenBotIA`,
        metadata: {
          type: 'renewal',
          renewalKey,
          subscriptionId: String(sub._id),
          businessId: String(sub.business),
          planKey: targetKey,
          userId: String(biz?.owner || ''),
        },
        idempotencyKey: `renewal_${renewalKey}_${attempt}`,
      });
    } catch (err) {
      await markFailed(sub, err.stripeCode || 'charge_failed', card);
      return 'failed';
    }

    if (pi.status !== 'succeeded') {
      // requires_action (3DS) u otro: el dueño debe pagar desde Facturación.
      await markFailed(sub, pi.status === 'requires_action' ? 'authentication_required' : pi.status, card);
      return 'failed';
    }

    // 4) Éxito.
    await finalizeRenewal({
      subscriptionId: sub._id,
      dueDate,
      planKey: targetKey,
      paymentIntentId: pi.id,
      amountMXN: info.priceMXN,
      userId: biz?.owner,
    });
    return 'renewed';
  } finally {
    await releaseLock(sub._id);
  }
}

/**
 * Aviso previo (REMINDER_DAYS antes) de que se cobrará la renovación. Si no hay
 * tarjeta guardada, el aviso pide agregarla para no perder el plan.
 */
async function sendUpcomingReminders(now) {
  const soon = new Date(now.getTime() + REMINDER_DAYS * DAY);
  const subs = await Subscription.find({
    renewalDate: { $gt: now, $lte: soon },
    status: { $ne: 'cancelada' },
  })
    .populate('plan')
    .limit(200);

  let sent = 0;
  for (const sub of subs) {
    const targetKey = nextPeriodPlanKey(sub);
    if (!isPaidPlanKey(targetKey)) continue;
    if (sub.renewalReminderFor && sub.renewalReminderFor.getTime() === sub.renewalDate.getTime()) continue;

    // Marca primero (atómico) para no enviar dos veces en paralelo.
    const claimed = await Subscription.updateOne(
      { _id: sub._id, renewalReminderFor: { $ne: sub.renewalDate } },
      { $set: { renewalReminderFor: sub.renewalDate } }
    );
    if (!claimed.modifiedCount) continue;

    const [biz, profile] = await Promise.all([
      ownerOf(sub.business),
      BillingProfile.findOne({ business: sub.business }).lean(),
    ]);
    const info = planInfo(targetKey);
    void sendRenewalNoticeEmail({
      kind: profile?.paymentMethod?.id ? 'upcoming' : 'upcoming_no_card',
      userId: biz?.owner,
      businessName: biz?.name,
      planName: info?.name,
      amountMXN: info?.priceMXN,
      card: profile?.paymentMethod ? { brand: profile.paymentMethod.brand, last4: profile.paymentMethod.last4 } : null,
      date: sub.renewalDate,
      url: billingUrl(),
    });
    sent += 1;
  }
  return sent;
}

let running = false;

/** Una pasada del cobrador: renovaciones vencidas + avisos previos. */
export async function runRenewals(now = new Date()) {
  if (running) return { skipped: true };
  running = true;
  try {
    const due = await Subscription.find({
      renewalDate: { $lte: now },
      $and: [
        { $or: [{ nextRenewalAttemptAt: null }, { nextRenewalAttemptAt: { $lte: now } }] },
        { $or: [{ renewalLockUntil: null }, { renewalLockUntil: { $lte: now } }] },
      ],
    })
      .select('_id')
      .limit(100)
      .lean();

    const result = { processed: 0, renewed: 0, failed: 0, free: 0, reminders: 0 };
    for (const { _id } of due) {
      try {
        const r = await renewSubscription(_id, now);
        result.processed += 1;
        if (r in result) result[r] += 1;
      } catch (err) {
        logger.error(`Renovación: error con suscripción ${_id}: ${err.message}`);
      }
    }
    result.reminders = await sendUpcomingReminders(now).catch((err) => {
      logger.warn(`Renovación: avisos previos fallaron: ${err.message}`);
      return 0;
    });
    return result;
  } finally {
    running = false;
  }
}

/** Programador en el proceso web (cada 15 min por defecto). */
export function startRenewalScheduler() {
  if (process.env.RENEWALS_ENABLED === 'false') {
    logger.info('Renovaciones: programador desactivado (RENEWALS_ENABLED=false).');
    return;
  }
  const minutes = Math.max(5, Number(process.env.RENEWALS_INTERVAL_MIN) || 15);
  const tick = () =>
    runRenewals()
      .then((r) => r.processed && logger.info(`Renovaciones: ${JSON.stringify(r)}`))
      .catch((err) => logger.warn(`Renovaciones: ${err.message}`));
  setTimeout(tick, 60 * 1000).unref?.(); // primera pasada al minuto de arrancar
  setInterval(tick, minutes * 60 * 1000).unref?.();
  logger.info(`Renovaciones: revisión cada ${minutes} min.`);
}
