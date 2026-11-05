import { connectNudgeEmail } from '../emails/connectNudge.js';
import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { Business } from '../models/Business.js';
import { Subscription } from '../models/Subscription.js';
import { Payment } from '../models/Payment.js';
import { Lead } from '../models/Lead.js';
import { MarketingSpend } from '../models/MarketingSpend.js';
import { ROLES } from '../config/constants.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { sendEmail } from './email.service.js';
import { sendMetaEvent } from './conversions.service.js';
import { newLeadEmail } from '../emails/newLead.js';
import { funnelReportEmail } from '../emails/funnelReport.js';
import { track, isClosing } from '../utils/inflight.js';

/**
 * Embudo comercial: de dónde llega cada registro, en qué etapa va y cuánto cuesta
 * conseguir un cliente. Etapas automáticas (salen de los datos):
 *   registrado → verificado → negocio creado → canal conectado → pagó
 */

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

/** Normaliza lo que manda el navegador (UTM, clics de anuncio, consentimiento). */
export function cleanAcquisition(acq = {}, ctx = {}) {
  if (!acq || typeof acq !== 'object') return null;
  const firstSeen = acq.firstSeenAt ? new Date(acq.firstSeenAt) : null;
  return {
    source: str(acq.source, 80).toLowerCase(),
    medium: str(acq.medium, 80).toLowerCase(),
    campaign: str(acq.campaign, 150),
    content: str(acq.content, 150),
    term: str(acq.term, 150),
    gclid: str(acq.gclid, 200),
    fbclid: str(acq.fbclid, 300),
    fbp: str(acq.fbp, 100),
    fbc: str(acq.fbc, 400),
    landing: str(acq.landing, 300),
    referrer: str(acq.referrer, 300),
    firstSeenAt: firstSeen && !Number.isNaN(firstSeen.getTime()) ? firstSeen : null,
    adsConsent: acq.adsConsent === true,
    ip: str(ctx.ip, 60),
    userAgent: str(ctx.userAgent, 400),
  };
}

/** Canal comercial de un registro (para agrupar y calcular costo por cliente). */
export function channelOf(user) {
  const a = user?.acquisition || {};
  const s = `${a.source} ${a.medium}`.toLowerCase();
  if (a.fbclid || /facebook|instagram|\bfb\b|\big\b|meta/.test(s)) return 'meta';
  if (a.gclid || /google|adwords|gads|\bcpc\b/.test(s)) return 'google';
  if (user?.referredBy) return 'referido';
  if (a.source) return 'otro';
  if (/google\.|bing\.|duckduckgo|yahoo/.test(a.referrer || '')) return 'organico';
  if (/facebook\.com|instagram\.com|t\.co|linkedin|tiktok/.test(a.referrer || '')) return 'social_organico';
  return 'directo';
}

export const CHANNEL_NAMES = {
  meta: 'Meta (pauta)',
  google: 'Google (pauta)',
  organico: 'Búsqueda orgánica',
  social_organico: 'Redes (orgánico)',
  referido: 'Referidos',
  otro: 'Otra campaña',
  directo: 'Directo',
};

/* ── Eventos del embudo ─────────────────────────────────────────────────── */

/** Registro completo (correo verificado o alta con Google). */
export async function onSignupComplete(user, ctx = {}) {
  try {
    await Lead.updateOne({ user: user._id }, { $setOnInsert: { user: user._id, stage: 'nuevo' } }, { upsert: true });
    void sendMetaEvent({ name: 'CompleteRegistration', eventId: `reg_${user._id}`, user, ctx, custom: { status: 'registered' } });
    void notifyNewLead(user);
  } catch (err) {
    logger.warn(`Embudo: registro ${user?._id}: ${err.message}`);
  }
}

/** Conectó un canal real (WhatsApp, Messenger, Instagram o chat web). */
export async function onChannelConnected(business, channel, ctx = {}) {
  try {
    const owner = await User.findById(business.owner).select('email acquisition');
    if (!owner) return;
    void sendMetaEvent({
      name: 'ChannelConnected',
      eventId: `ch_${channel}_${business._id}`,
      user: owner,
      ctx,
      custom: { channel },
    });
  } catch (err) {
    logger.warn(`Embudo: canal ${channel}: ${err.message}`);
  }
}

/** Pago hecho por el cliente (no renovaciones ni recargas automáticas). */
export async function onPurchase(payment, ctx = {}) {
  try {
    if (!payment || payment.renewal) return;
    const user = await User.findById(payment.user).select('email acquisition');
    if (!user) return;
    void sendMetaEvent({
      name: 'Purchase',
      eventId: `pay_${payment.stripeSessionId}`,
      user,
      ctx,
      custom: {
        value: Number(payment.amountMXN) || 0,
        currency: 'MXN',
        content_name: payment.planKey || payment.packKey || payment.type,
        content_type: 'product',
      },
    });
  } catch (err) {
    logger.warn(`Embudo: pago: ${err.message}`);
  }
}

/** Aviso al equipo comercial de un registro nuevo. */
async function notifyNewLead(user) {
  const to = env.funnel.alertEmails;
  if (!to.length) return;
  const { subject, html } = newLeadEmail({
    name: user.name,
    email: user.email,
    channel: CHANNEL_NAMES[channelOf(user)],
    campaign: user.acquisition?.campaign || '',
    url: `${env.publicUrl.replace(/\/$/, '')}/dashboard/embudo`,
  });
  for (const addr of to) void sendEmail({ to: addr, subject, html });
}

/* ── Datos del tablero ──────────────────────────────────────────────────── */

const PAID_KEYS = new Set(['pro', 'elite']);

/**
 * Registros (clientes, sin cuentas internas) con su etapa automática y su canal.
 * @param {{ from?: Date, to?: Date, limit?: number }} opts
 */
export async function funnelRows({ from, to, limit = 5000 } = {}) {
  const match = { role: ROLES.CLIENTE };
  if (from || to) match.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) };
  const users = await User.find(match)
    .select('name email emailVerified createdAt acquisition referredBy')
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  if (!users.length) return [];
  const ids = users.map((u) => u._id);

  const [businesses, payments, leads] = await Promise.all([
    Business.find({ owner: { $in: ids } })
      .select('owner name industry whatsappNumber whatsappPhoneNumberId facebookPageId instagramAccountId widget.enabled createdAt')
      .lean(),
    Payment.aggregate([
      { $match: { user: { $in: ids }, status: 'completed' } },
      { $group: { _id: '$user', total: { $sum: '$amountMXN' }, first: { $min: '$createdAt' }, count: { $sum: 1 } } },
    ]),
    Lead.find({ user: { $in: ids } }).populate('assignee', 'name email').lean(),
  ]);
  const subs = await Subscription.find({ business: { $in: businesses.map((b) => b._id) } })
    .select('business plan complimentary')
    .populate('plan', 'key')
    .lean();

  const bizByOwner = new Map(businesses.map((b) => [String(b.owner), b]));
  const subByBiz = new Map(subs.map((s) => [String(s.business), s]));
  const payByUser = new Map(payments.map((p) => [String(p._id), p]));
  const leadByUser = new Map(leads.map((l) => [String(l.user), l]));

  return users.map((u) => {
    const b = bizByOwner.get(String(u._id));
    const sub = b ? subByBiz.get(String(b._id)) : null;
    const pay = payByUser.get(String(u._id));
    const channels = b
      ? [
          b.whatsappPhoneNumberId && 'whatsapp',
          b.facebookPageId && 'messenger',
          b.instagramAccountId && 'instagram',
          b.widget?.enabled && 'web',
        ].filter(Boolean)
      : [];
    const planKey = sub?.plan?.key || 'free';
    const paying = Boolean(pay) || (PAID_KEYS.has(planKey) && !sub?.complimentary);
    const autoStage = paying ? 'pago' : channels.length ? 'conectado' : b ? 'negocio' : u.emailVerified ? 'verificado' : 'registrado';
    const lead = leadByUser.get(String(u._id));
    return {
      userId: String(u._id),
      name: u.name,
      email: u.email,
      createdAt: u.createdAt,
      channel: channelOf(u),
      campaign: u.acquisition?.campaign || '',
      business: b ? { id: String(b._id), name: b.name, industry: b.industry, phone: b.whatsappNumber || '' } : null,
      channels,
      planKey,
      complimentary: Boolean(sub?.complimentary),
      revenueMXN: pay?.total || 0,
      firstPaymentAt: pay?.first || null,
      autoStage,
      lead: lead
        ? {
            id: String(lead._id),
            stage: lead.stage,
            assignee: lead.assignee ? { id: String(lead.assignee._id), name: lead.assignee.name } : null,
            phone: lead.phone,
            nextFollowUpAt: lead.nextFollowUpAt,
            lostReason: lead.lostReason,
            notes: (lead.notes || []).slice(-20),
            firstContactAt: lead.firstContactAt,
          }
        : null,
    };
  });
}

const STAGE_ORDER = ['registrado', 'verificado', 'negocio', 'conectado', 'pago'];

/** Resumen: conteo por etapa (acumulado) y por canal, con inversión y costo por cliente. */
export async function funnelSummary({ from, to }) {
  const rows = await funnelRows({ from, to });
  const reached = (r, stage) => STAGE_ORDER.indexOf(r.autoStage) >= STAGE_ORDER.indexOf(stage);
  const count = (list) => Object.fromEntries(STAGE_ORDER.map((s) => [s, list.filter((r) => reached(r, s)).length]));

  // Inversión de los meses que toca el rango.
  const months = [];
  const start = from || (rows.length ? new Date(Math.min(...rows.map((r) => new Date(r.createdAt)))) : new Date());
  const end = to || new Date();
  for (let d = new Date(start.getFullYear(), start.getMonth(), 1); d < end; d.setMonth(d.getMonth() + 1)) {
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const spend = await MarketingSpend.find({ month: { $in: months } }).lean();
  const spendBy = (ch) => spend.filter((s) => s.channel === ch).reduce((a, s) => a + s.amountMXN, 0);
  const totalSpend = spend.reduce((a, s) => a + s.amountMXN, 0);

  const byChannel = {};
  for (const r of rows) (byChannel[r.channel] ||= []).push(r);
  const channels = Object.entries(byChannel)
    .map(([ch, list]) => {
      const c = count(list);
      const adSpend = ch === 'meta' || ch === 'google' ? spendBy(ch) : 0;
      return {
        channel: ch,
        name: CHANNEL_NAMES[ch] || ch,
        ...c,
        revenueMXN: list.reduce((a, r) => a + r.revenueMXN, 0),
        spendMXN: adSpend,
        cacMXN: adSpend && c.pago ? Math.round(adSpend / c.pago) : null,
        costPerSignupMXN: adSpend && c.registrado ? Math.round(adSpend / c.registrado) : null,
      };
    })
    .sort((a, b) => b.registrado - a.registrado);

  const totals = count(rows);
  return {
    range: { from, to, months },
    totals: {
      ...totals,
      revenueMXN: rows.reduce((a, r) => a + r.revenueMXN, 0),
      spendMXN: totalSpend,
      // Costo por cliente "combinado": toda la inversión (pauta + agencia) / clientes que pagaron.
      blendedCacMXN: totalSpend && totals.pago ? Math.round(totalSpend / totals.pago) : null,
    },
    channels,
    spend,
  };
}

/* ── Reportes automáticos ───────────────────────────────────────────────── */

const stateCol = () => mongoose.connection.db.collection('system_state');

/** Reclama una ejecución única por clave (evita duplicados entre reinicios). */
async function claimRun(key) {
  const res = await stateCol().updateOne({ _id: key }, { $setOnInsert: { at: new Date() } }, { upsert: true });
  return res.upsertedCount === 1;
}

/** Fecha/hora en México (America/Mexico_City). */
function mxNow(now = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Mexico_City',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((x) => [x.type, x.value])
  );
  return { ymd: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), weekday: p.weekday };
}

/** Lunes 8:00 (México): reporte semanal del embudo a dueño y agencia. */
export async function sendWeeklyReport(now = new Date()) {
  const to = env.funnel.reportEmails;
  if (!to.length) return { skipped: 'no_recipients' };
  const weekAgo = new Date(now.getTime() - 7 * 864e5);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const [week, month] = await Promise.all([funnelSummary({ from: weekAgo, to: now }), funnelSummary({ from: monthStart, to: now })]);
  const { subject, html } = funnelReportEmail({ week, month, url: `${env.publicUrl.replace(/\/$/, '')}/dashboard/embudo` });
  for (const addr of to) await sendEmail({ to: addr, subject, html });
  return { sent: to.length };
}

/** Diario 9:00 (México): pendientes del equipo comercial. */
export async function sendDailyDigest(now = new Date()) {
  const to = env.funnel.alertEmails;
  if (!to.length) return { skipped: 'no_recipients' };
  const rows = await funnelRows({ from: new Date(now.getTime() - 30 * 864e5), to: now, limit: 1000 });
  const endOfDay = new Date(now.getTime() + 864e5);
  const uncontacted = rows.filter((r) => r.autoStage !== 'pago' && (!r.lead || r.lead.stage === 'nuevo'));
  const due = rows.filter((r) => r.lead?.nextFollowUpAt && new Date(r.lead.nextFollowUpAt) <= endOfDay && !['ganado', 'perdido'].includes(r.lead.stage));
  const stuck = rows.filter((r) => r.autoStage === 'negocio' && r.lead?.stage !== 'perdido');
  if (!uncontacted.length && !due.length && !stuck.length) return { skipped: 'nothing' };
  const li = (list) =>
    list
      .slice(0, 25)
      .map((r) => `<li>${escapeHtml(r.name)} · ${escapeHtml(r.email)}${r.business?.phone ? ` · ${escapeHtml(r.business.phone)}` : ''} <span style="color:#64748B">(${CHANNEL_NAMES[r.channel]})</span></li>`)
      .join('');
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#0F172A">
    <h2 style="margin:0 0 12px">Pendientes de hoy</h2>
    ${uncontacted.length ? `<h3>Sin contactar (${uncontacted.length})</h3><ul>${li(uncontacted)}</ul>` : ''}
    ${due.length ? `<h3>Seguimiento para hoy (${due.length})</h3><ul>${li(due)}</ul>` : ''}
    ${stuck.length ? `<h3>Crearon su negocio pero no conectaron canal (${stuck.length})</h3><p style="color:#64748B">Candidatos para conexión asistida.</p><ul>${li(stuck)}</ul>` : ''}
    <p><a href="${env.publicUrl.replace(/\/$/, '')}/dashboard/embudo" style="color:#0E8A68;font-weight:bold">Abrir el embudo</a></p></div>`;
  for (const addr of to) await sendEmail({ to: addr, subject: `RenBotIA · ${uncontacted.length + due.length} pendientes de seguimiento`, html });
  return { sent: to.length };
}

function escapeHtml(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const HOUR = 36e5;
/** Momento de cada aviso (desde el registro): 3 h y 48 h. */
const NUDGE_AFTER = [3 * HOUR, 48 * HOUR];

/**
 * Ayuda automática a quien se registró y no conectó un canal (máx. 2 correos).
 * Solo registros de los últimos 7 días; nunca a quien ya pagó o el equipo marcó
 * como ganado o perdido.
 */
export async function sendConnectNudges(now = new Date()) {
  if (!env.funnel.nudgesEnabled) return { skipped: 'disabled' };
  const rows = await funnelRows({ from: new Date(now.getTime() - 7 * 24 * HOUR), to: now, limit: 1000 });
  const base = env.publicUrl.replace(/\/$/, '');
  let sent = 0;
  for (const r of rows) {
    if (!['verificado', 'negocio'].includes(r.autoStage)) continue;
    if (['ganado', 'perdido'].includes(r.lead?.stage)) continue;
    const n = r.lead ? await Lead.findById(r.lead.id).select('nudgesSent').lean() : null;
    const count = n?.nudgesSent || 0;
    if (count >= NUDGE_AFTER.length) continue;
    if (now - new Date(r.createdAt) < NUDGE_AFTER[count]) continue;
    // Reclamo atómico: un solo envío por aviso aunque haya dos procesos.
    const claim = await Lead.updateOne(
      { user: r.userId, nudgesSent: count },
      { $set: { nudgesSent: count + 1, lastNudgeAt: now }, $setOnInsert: { stage: 'nuevo' } },
      { upsert: !r.lead }
    );
    if (!claim.modifiedCount && !claim.upsertedCount) continue;
    const { subject, html } = connectNudgeEmail({
      name: r.name,
      step: r.autoStage,
      second: count === 1,
      bookingUrl: env.funnel.bookingUrl || `${base}/contacto`,
      connectUrl: `${base}/dashboard/conexiones`,
      onboardingUrl: `${base}/onboarding`,
    });
    await sendEmail({ to: r.email, subject, html });
    sent += 1;
  }
  return { sent };
}

/** Programador: revisa cada 15 min si toca el resumen diario o el reporte del lunes. */
export function startFunnelScheduler() {
  if (process.env.FUNNEL_REPORTS_ENABLED === 'false') return;
  const tick = async () => {
    if (isClosing()) return;
    const { ymd, hour, weekday } = mxNow();
    try {
      if (hour >= 9 && (await claimRun(`funnel_daily_${ymd}`))) await track(sendDailyDigest());
      if (weekday === 'Mon' && hour >= 8 && (await claimRun(`funnel_weekly_${ymd}`))) await track(sendWeeklyReport());
      // Ayuda para conectar: solo en horario razonable (8 a 21 h de México).
      if (hour >= 8 && hour < 21) await track(sendConnectNudges());
    } catch (err) {
      logger.warn(`Embudo: reportes: ${err.message}`);
    }
  };
  setTimeout(tick, 2 * 60 * 1000).unref?.();
  setInterval(tick, 15 * 60 * 1000).unref?.();
  logger.info('Embudo: resumen diario 9:00 y reporte semanal lunes 8:00 (hora de México).');
}
