import { User } from '../models/User.js';
import { Business } from '../models/Business.js';
import { Subscription } from '../models/Subscription.js';
import { Payment } from '../models/Payment.js';
import { Lead } from '../models/Lead.js';
import { BillingProfile } from '../models/BillingProfile.js';
import { ChatSimulation } from '../models/ChatSimulation.js';
import { CANCEL_REASONS } from '../config/constants.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { sendEmail, sendRenewalNoticeEmail } from './email.service.js';
import { annualInfo, isFounderWindow, founderUntil, hasActiveAnnual, nextChargeDate } from './pricing.service.js';
import { isPaidPlanKey, nextPeriodPlanKey } from './token.service.js';
import { annualOfferEmail } from '../emails/annualOffer.js';

/**
 * Retención de clientes que pagan:
 *  1. Cancelación con motivo: queda en el CRM y avisa al equipo para intentar salvarla.
 *  2. Oferta del plan anual (una vez) a los 20–25 días de un mes pagado.
 *  3. Aviso de tarjeta por vencer (una vez por tarjeta).
 *  4. Clientes que pagan y llevan días sin conversaciones (resumen diario y Embudo).
 */

const DAY = 864e5;
const base = () => env.publicUrl.replace(/\/$/, '');
const fmtDay = (d) =>
  new Date(d).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' });
const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ── 1. Cancelación con motivo ──────────────────────────────────────────── */

/**
 * Registra el motivo en el CRM (nota + seguimiento para hoy) y avisa al equipo.
 * Fail-open: nunca impide cancelar.
 */
export async function recordCancellation({ sub, userId, reason, comment, accessUntil }) {
  try {
    const biz = await Business.findById(sub.business).select('owner name whatsappNumber').lean();
    const owner = biz ? await User.findById(biz.owner).select('name email role').lean() : null;
    const reasonText = CANCEL_REASONS[reason] || 'Sin motivo';
    const planName = sub.plan?.name || 'de pago';
    const until = accessUntil ? fmtDay(accessUntil) : '';
    if (owner?.role === 'cliente') {
      const text = `Canceló su plan ${planName}${until ? ` (activo hasta el ${until})` : ''}. Motivo: ${reasonText}.${
        comment ? ` Comentario: "${comment}"` : ''
      }`;
      await Lead.updateOne(
        { user: owner._id },
        {
          $setOnInsert: { user: owner._id, stage: 'nuevo' },
          $set: { nextFollowUpAt: new Date() },
          $push: { notes: { $each: [{ by: userId, byName: 'Sistema', text: text.slice(0, 1000) }], $slice: -200 } },
        },
        { upsert: true }
      );
    }
    const to = env.funnel.alertEmails;
    if (!to.length || !owner) return;
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#0F172A">
      <h2 style="margin:0 0 12px">Un cliente canceló su plan</h2>
      <p><b>${esc(owner.name)}</b> · ${esc(owner.email)}${biz?.whatsappNumber ? ` · ${esc(biz.whatsappNumber)}` : ''}<br>
      Negocio: ${esc(biz?.name || '')} · Plan ${esc(planName)}${until ? ` · activo hasta el ${until}` : ''}</p>
      <p><b>Motivo:</b> ${esc(reasonText)}${comment ? `<br><b>Comentario:</b> ${esc(comment)}` : ''}</p>
      <p style="color:#64748B">Aún tiene acceso: una llamada hoy puede evitar que se vaya. Quedó en "Seguimiento para hoy" del Embudo.</p>
      <p><a href="${base()}/dashboard/embudo" style="color:#0E8A68;font-weight:bold">Abrir el embudo</a></p></div>`;
    for (const addr of to) void sendEmail({ to: addr, subject: `RenBotIA · Canceló: ${owner.name} (${reasonText})`, html });
  } catch (err) {
    logger.warn(`Retención: cancelación ${sub?._id}: ${err.message}`);
  }
}

/* ── 2. Oferta del plan anual ───────────────────────────────────────────── */

/** Días 20 a 25 de un mes PAGADO (no regalo ni cortesía), una sola vez por suscripción. */
export async function sendAnnualOffers(now = new Date()) {
  const subs = await Subscription.find({
    billingCycle: { $ne: 'anual' },
    status: 'activa',
    complimentary: { $ne: true },
    periodPaidMXN: { $gt: 0 },
    annualOfferSentAt: null,
    pendingPlanKey: { $in: ['', null] },
    currentPeriodStart: { $lte: new Date(now.getTime() - 20 * DAY), $gte: new Date(now.getTime() - 25 * DAY) },
    renewalDate: { $gt: now },
  })
    .populate('plan')
    .limit(200);

  let sent = 0;
  for (const sub of subs) {
    const info = annualInfo(sub.plan?.key, now);
    if (!info) continue;
    // Reclamo atómico: un solo correo aunque corran dos procesos.
    const claim = await Subscription.updateOne({ _id: sub._id, annualOfferSentAt: null }, { $set: { annualOfferSentAt: now } });
    if (!claim.modifiedCount) continue;
    const biz = await Business.findById(sub.business).select('owner').lean();
    const owner = biz ? await User.findById(biz.owner).select('name email').lean() : null;
    if (!owner?.email) continue;
    const { subject, html } = annualOfferEmail({
      name: owner.name,
      planName: sub.plan.name,
      monthlyMXN: sub.plan.priceMXN,
      annualMXN: info.priceMXN,
      perMonthMXN: info.perMonthMXN,
      savingsMXN: info.savingsMXN,
      monthsPaid: info.monthsPaid,
      founder: isFounderWindow(now),
      founderUntil: founderUntil(),
      startsAt: sub.renewalDate,
      url: `${base()}/dashboard/facturacion`,
    });
    void sendEmail({ to: owner.email, subject, html });
    sent += 1;
  }
  return { sent };
}

/* ── 3. Tarjeta por vencer ──────────────────────────────────────────────── */

/** Fin de la vigencia de una tarjeta (vence al terminar su mes). */
export const cardEndsAt = (pm) => (pm?.expYear && pm?.expMonth ? new Date(Date.UTC(pm.expYear, pm.expMonth, 1, 6)) : null);

/**
 * Avisa 30 días antes de que venza la tarjeta guardada, solo si con ella se va a
 * cobrar algo (renovación de un plan de pago o recarga automática). Un aviso por tarjeta.
 */
export async function sendCardExpiryNotices(now = new Date()) {
  const profiles = await BillingProfile.find({ 'paymentMethod.id': { $exists: true }, paymentMethod: { $ne: null } })
    .select('business paymentMethod autoRecharge cardExpiryNoticeFor')
    .limit(2000)
    .lean();
  let sent = 0;
  for (const prof of profiles) {
    const pm = prof.paymentMethod;
    const ends = cardEndsAt(pm);
    if (!ends || ends.getTime() - now.getTime() > 30 * DAY) continue;
    if (prof.cardExpiryNoticeFor === pm.id) continue;
    const sub = await Subscription.findOne({ business: prof.business }).populate('plan');
    const chargesPlan =
      sub && !sub.complimentary && (hasActiveAnnual(sub, now) || isPaidPlanKey(nextPeriodPlanKey(sub)));
    if (!chargesPlan && !prof.autoRecharge?.enabled) continue;
    const claim = await BillingProfile.updateOne(
      { _id: prof._id, cardExpiryNoticeFor: { $ne: pm.id } },
      { $set: { cardExpiryNoticeFor: pm.id } }
    );
    if (!claim.modifiedCount) continue;
    const biz = await Business.findById(prof.business).select('owner name').lean();
    void sendRenewalNoticeEmail({
      kind: 'card_expiring',
      userId: biz?.owner,
      businessName: biz?.name,
      card: { brand: pm.brand, last4: pm.last4 },
      expires: `${String(pm.expMonth).padStart(2, '0')}/${pm.expYear}`,
      nextCharge: chargesPlan ? nextChargeDate(sub) : null,
      url: `${base()}/dashboard/facturacion`,
    });
    sent += 1;
  }
  return { sent };
}

/* ── 4. Clientes que pagan sin conversaciones ───────────────────────────── */

/** Última conversación real (no simulador) por negocio. */
export async function lastActivityByBusiness(businessIds) {
  if (!businessIds.length) return new Map();
  const rows = await ChatSimulation.aggregate([
    { $match: { business: { $in: businessIds }, channel: { $ne: 'simulator' } } },
    { $group: { _id: '$business', last: { $max: '$updatedAt' } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.last]));
}

/**
 * Negocios que PAGAN (sin cortesía) desde hace más de `days` días y no han tenido
 * conversaciones reales en ese tiempo: la señal más temprana de que van a cancelar.
 */
export async function inactivePayingCustomers(now = new Date(), days = 7) {
  const since = new Date(now.getTime() - days * DAY);
  const subs = await Subscription.find({ complimentary: { $ne: true }, status: { $in: ['activa', 'cancelada'] } })
    .populate('plan', 'key name priceMXN')
    .select('business plan status billingCycle')
    .lean();
  const paying = subs.filter((s) => (s.plan?.priceMXN || 0) > 0);
  if (!paying.length) return [];
  const ids = paying.map((s) => s.business);
  // Que lleve más de `days` días pagando (no alertar a quien acaba de comprar).
  const firstPay = await Payment.aggregate([
    { $match: { business: { $in: ids }, status: 'completed', type: 'plan' } },
    { $group: { _id: '$business', first: { $min: '$createdAt' } } },
  ]);
  const firstBy = new Map(firstPay.map((p) => [String(p._id), p.first]));
  const lastBy = await lastActivityByBusiness(ids);
  const out = [];
  for (const s of paying) {
    const id = String(s.business);
    const first = firstBy.get(id);
    if (!first || first > since) continue;
    const last = lastBy.get(id) || null;
    if (last && last > since) continue;
    out.push({ businessId: id, planName: s.plan.name, status: s.status, cycle: s.billingCycle || 'mensual', lastActivityAt: last });
  }
  if (!out.length) return out;
  const bizs = await Business.find({ _id: { $in: out.map((o) => o.businessId) } }).select('owner name whatsappNumber').lean();
  const owners = await User.find({ _id: { $in: bizs.map((b) => b.owner) } }).select('name email').lean();
  const bizBy = new Map(bizs.map((b) => [String(b._id), b]));
  const ownerBy = new Map(owners.map((u) => [String(u._id), u]));
  return out.map((o) => {
    const b = bizBy.get(o.businessId);
    const u = b ? ownerBy.get(String(b.owner)) : null;
    return { ...o, businessName: b?.name || '', phone: b?.whatsappNumber || '', ownerName: u?.name || '', email: u?.email || '' };
  });
}
