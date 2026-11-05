import { User } from '../models/User.js';
import { Payment } from '../models/Payment.js';
import { MarketingSpend } from '../models/MarketingSpend.js';
import { ROLES } from '../config/constants.js';
import { funnelRows, CHANNEL_NAMES } from './funnel.service.js';

/**
 * Resultados de campañas PAGADAS (Meta y Google) para la agencia de marketing.
 * Solo cifras agregadas: nunca nombres, correos, teléfonos ni notas. Tampoco el
 * ingreso de clientes que no llegaron por anuncios.
 */

export const PAID_CHANNELS = ['meta', 'google'];
const STAGES = ['registrado', 'verificado', 'negocio', 'conectado', 'pago'];
const reached = (r, stage) => STAGES.indexOf(r.autoStage) >= STAGES.indexOf(stage);

function monthsBetween(from, to) {
  const months = [];
  for (let d = new Date(from.getFullYear(), from.getMonth(), 1); d < to; d.setMonth(d.getMonth() + 1)) {
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return months;
}

/** Lunes (AAAA-MM-DD) de la semana de una fecha, en hora de México. */
function weekOf(date) {
  const mx = new Date(new Date(date).toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  const day = (mx.getDay() + 6) % 7; // 0 = lunes
  mx.setDate(mx.getDate() - day);
  return `${mx.getFullYear()}-${String(mx.getMonth() + 1).padStart(2, '0')}-${String(mx.getDate()).padStart(2, '0')}`;
}

function tally(list) {
  const t = Object.fromEntries(STAGES.map((s) => [s, list.filter((r) => reached(r, s)).length]));
  t.revenueMXN = list.reduce((a, r) => a + (r.revenueMXN || 0), 0);
  t.annual = list.filter((r) => r.autoStage === 'pago' && r.cycle === 'anual').length;
  return t;
}

/**
 * @param {{ from: Date, to: Date }} range
 */
export async function campaignReport({ from, to }) {
  const rows = (await funnelRows({ from, to })).filter((r) => PAID_CHANNELS.includes(r.channel));

  // Por campaña y anuncio (utm_campaign / utm_content).
  const groups = new Map();
  for (const r of rows) {
    const key = [r.channel, r.source || '', r.campaign || '(sin campaña)', r.content || ''].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const campaigns = [...groups.entries()]
    .map(([key, list]) => {
      const [channel, source, campaign, content] = key.split('|');
      return { channel, source, campaign, content, ...tally(list) };
    })
    .sort((a, b) => b.registrado - a.registrado);

  // Por canal, con la inversión capturada y el costo por cliente.
  const months = monthsBetween(from, to);
  const spend = await MarketingSpend.find({ month: { $in: months }, channel: { $in: PAID_CHANNELS } }).lean();
  const channels = PAID_CHANNELS.map((ch) => {
    const t = tally(rows.filter((r) => r.channel === ch));
    const spendMXN = spend.filter((s) => s.channel === ch).reduce((a, s) => a + s.amountMXN, 0);
    return {
      channel: ch,
      name: CHANNEL_NAMES[ch],
      ...t,
      spendMXN,
      costPerSignupMXN: spendMXN && t.registrado ? Math.round(spendMXN / t.registrado) : null,
      costPerConnectedMXN: spendMXN && t.conectado ? Math.round(spendMXN / t.conectado) : null,
      cacMXN: spendMXN && t.pago ? Math.round(spendMXN / t.pago) : null,
      roas: spendMXN ? Math.round((t.revenueMXN / spendMXN) * 100) / 100 : null,
    };
  });

  // Semana a semana (registros de pauta y hasta dónde llegaron).
  const byWeek = new Map();
  for (const r of rows) {
    const w = weekOf(r.createdAt);
    if (!byWeek.has(w)) byWeek.set(w, []);
    byWeek.get(w).push(r);
  }
  const weeks = [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, list]) => ({ week, ...tally(list) }));

  return { range: { from, to, months }, totals: tally(rows), channels, campaigns, weeks, spend };
}

/* ── Conversiones fuera de línea para Google Ads ─────────────────────────── */

const mxTime = (d) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Mexico_City',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(d))
      .map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
};

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * CSV para "Cargas → Conversiones" de Google Ads: pagos de personas que llegaron
 * por un anuncio de Google (gclid) y aceptaron la medición de campañas.
 *  - "Compra": primera compra o mejora (Order ID = el mismo transaction_id que
 *    manda el sitio, así Google no la cuenta dos veces).
 *  - "Renovación": cobros de renovación (valor del cliente a largo plazo).
 */
export async function offlineConversionsCsv({ from, to }) {
  const users = await User.find({
    role: ROLES.CLIENTE,
    'acquisition.gclid': { $nin: [null, ''] },
    'acquisition.adsConsent': true,
  })
    .select('_id acquisition.gclid')
    .lean();
  const gclidByUser = new Map(users.map((u) => [String(u._id), u.acquisition.gclid]));
  const payments = users.length
    ? await Payment.find({
        user: { $in: users.map((u) => u._id) },
        status: 'completed',
        createdAt: { $gte: from, $lt: to },
      })
        .sort({ createdAt: 1 })
        .lean()
    : [];

  const lines = [
    'Parameters:TimeZone=America/Mexico_City',
    'Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency,Order ID',
  ];
  for (const p of payments) {
    const gclid = gclidByUser.get(String(p.user));
    // Las recargas automáticas de créditos no son una decisión de compra: fuera.
    if (!gclid || String(p.stripeSessionId).startsWith('autopi_')) continue;
    const orderId = String(p.stripeSessionId || '').replace(/^renewpi_/, '');
    lines.push(
      [gclid, p.renewal ? 'Renovación' : 'Compra', mxTime(p.createdAt), Number(p.amountMXN) || 0, 'MXN', orderId]
        .map(csvCell)
        .join(',')
    );
  }
  return { csv: `${lines.join('\n')}\n`, count: lines.length - 2 };
}
