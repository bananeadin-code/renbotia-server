import { z } from 'zod';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { Lead, LEAD_STAGES } from '../models/Lead.js';
import { MarketingSpend, SPEND_CHANNELS } from '../models/MarketingSpend.js';
import { User } from '../models/User.js';
import { ROLES } from '../config/constants.js';
import { funnelRows, funnelSummary, sendWeeklyReport, CHANNEL_NAMES } from '../services/funnel.service.js';
import { campaignReport, offlineConversionsCsv, PAID_CHANNELS } from '../services/campaigns.service.js';

/** Rango ?from=AAAA-MM-DD&to=AAAA-MM-DD (por defecto, últimos 30 días). */
function rangeOf(q) {
  const parse = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00-06:00`) : null);
  const to = parse(q.to) ? new Date(parse(q.to).getTime() + 864e5) : new Date();
  const from = parse(q.from) || new Date(to.getTime() - 30 * 864e5);
  if (from >= to) throw ApiError.badRequest('El rango de fechas no es válido.');
  return { from, to };
}

const isAdmin = (req) => req.user?.role === ROLES.ADMIN;

/** GET /api/funnel/summary — embudo por etapa y canal, con inversión y costo por cliente (admin). */
export const getSummary = asyncHandler(async (req, res) => {
  const summary = await funnelSummary(rangeOf(req.query));
  res.json({ success: true, data: { summary, channelNames: CHANNEL_NAMES } });
});

/** GET /api/funnel/leads — registros con su etapa y seguimiento (admin y soporte). */
export const getLeads = asyncHandler(async (req, res) => {
  let rows = await funnelRows({ ...rangeOf(req.query), limit: 2000 });
  const { stage, auto, channel, assignee, q } = req.query;
  if (stage) rows = rows.filter((r) => (r.lead?.stage || 'nuevo') === stage);
  if (auto) rows = rows.filter((r) => r.autoStage === auto);
  if (channel) rows = rows.filter((r) => r.channel === channel);
  if (assignee === 'none') rows = rows.filter((r) => !r.lead?.assignee);
  else if (assignee === 'me') rows = rows.filter((r) => r.lead?.assignee?.id === String(req.userId));
  else if (assignee) rows = rows.filter((r) => r.lead?.assignee?.id === assignee);
  if (q) {
    const needle = String(q).toLowerCase().slice(0, 80);
    rows = rows.filter((r) => `${r.name} ${r.email} ${r.business?.name || ''} ${r.business?.phone || ''}`.toLowerCase().includes(needle));
  }
  // El equipo de soporte no ve montos.
  if (!isAdmin(req)) rows = rows.map(({ revenueMXN, ...r }) => r);
  res.json({ success: true, data: { leads: rows.slice(0, 500), total: rows.length, channelNames: CHANNEL_NAMES } });
});

/** GET /api/funnel/staff — personas del equipo a quienes asignar. */
export const getStaff = asyncHandler(async (req, res) => {
  const staff = await User.find({ role: { $in: [ROLES.ADMIN, ROLES.SOPORTE] } }).select('name email role').lean();
  res.json({ success: true, data: { staff: staff.map((s) => ({ id: String(s._id), name: s.name, email: s.email, role: s.role })) } });
});

export const updateLeadSchema = z.object({
  stage: z.enum(LEAD_STAGES).optional(),
  assigneeId: z.string().max(40).nullable().optional(),
  phone: z.string().trim().max(30).optional(),
  nextFollowUpAt: z.string().max(40).nullable().optional(),
  lostReason: z.string().trim().max(300).optional(),
  // true = la sesión de orientación por videollamada ya se dio.
  orientationDone: z.boolean().optional(),
});

async function leadFor(userId) {
  if (!mongoose.isValidObjectId(userId)) throw ApiError.notFound('Registro no encontrado');
  const user = await User.findOne({ _id: userId, role: ROLES.CLIENTE }).select('_id');
  if (!user) throw ApiError.notFound('Registro no encontrado');
  return Lead.findOneAndUpdate({ user: user._id }, { $setOnInsert: { user: user._id } }, { upsert: true, new: true });
}

/** PATCH /api/funnel/leads/:userId — etapa, responsable, teléfono, próximo seguimiento. */
export const updateLead = asyncHandler(async (req, res) => {
  const lead = await leadFor(req.params.userId);
  const { stage, assigneeId, phone, nextFollowUpAt, lostReason, orientationDone } = req.body;
  if (orientationDone !== undefined) lead.orientationAt = orientationDone ? lead.orientationAt || new Date() : null;
  if (stage !== undefined) {
    if (stage !== 'nuevo' && !lead.firstContactAt) lead.firstContactAt = new Date();
    lead.stage = stage;
  }
  if (assigneeId !== undefined) {
    if (assigneeId === null || assigneeId === '') lead.assignee = null;
    else {
      const staff = mongoose.isValidObjectId(assigneeId)
        ? await User.findOne({ _id: assigneeId, role: { $in: [ROLES.ADMIN, ROLES.SOPORTE] } }).select('_id')
        : null;
      if (!staff) throw ApiError.badRequest('Esa persona no es parte del equipo.');
      lead.assignee = staff._id;
    }
  }
  if (phone !== undefined) lead.phone = phone;
  if (lostReason !== undefined) lead.lostReason = lostReason;
  if (nextFollowUpAt !== undefined) {
    const d = nextFollowUpAt ? new Date(nextFollowUpAt) : null;
    if (d && Number.isNaN(d.getTime())) throw ApiError.badRequest('Fecha de seguimiento no válida.');
    lead.nextFollowUpAt = d;
  }
  await lead.save();
  res.json({ success: true, data: { ok: true } });
});

export const noteSchema = z.object({ text: z.string().trim().min(1, 'Escribe la nota').max(1000) });

/** POST /api/funnel/leads/:userId/notes — nota de una llamada o seguimiento. */
export const addNote = asyncHandler(async (req, res) => {
  const lead = await leadFor(req.params.userId);
  lead.notes.push({ by: req.userId, byName: req.user?.name || '', text: req.body.text });
  if (lead.notes.length > 200) lead.notes = lead.notes.slice(-200);
  if (!lead.firstContactAt) lead.firstContactAt = new Date();
  await lead.save();
  res.status(201).json({ success: true, data: { notes: lead.notes.slice(-20) } });
});

/* ── Inversión (solo admin) ─────────────────────────────────────────────── */

export const spendSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, 'Mes con formato AAAA-MM'),
  channel: z.enum(SPEND_CHANNELS),
  amountMXN: z.number().min(0).max(10_000_000),
  note: z.string().trim().max(200).optional().default(''),
});

/** GET /api/funnel/spend — inversión capturada (últimos 12 meses). */
export const getSpend = asyncHandler(async (req, res) => {
  const spend = await MarketingSpend.find().sort({ month: -1, channel: 1 }).limit(60).lean();
  res.json({ success: true, data: { spend } });
});

/** PUT /api/funnel/spend — guarda la inversión de un mes y canal (reemplaza). */
export const putSpend = asyncHandler(async (req, res) => {
  const { month, channel, amountMXN, note } = req.body;
  await MarketingSpend.updateOne({ month, channel }, { $set: { amountMXN, note } }, { upsert: true });
  res.json({ success: true, data: { ok: true } });
});

/* ── Agencia de marketing (admin + agencia): solo cifras de pauta ─────────── */

const isAgency = (req) => req.user?.role === ROLES.AGENCIA;

/** GET /api/funnel/campaigns — resultados por campaña, canal y semana (sin datos personales). */
export const getCampaigns = asyncHandler(async (req, res) => {
  const report = await campaignReport(rangeOf(req.query));
  res.json({ success: true, data: { report, channelNames: CHANNEL_NAMES } });
});

/** GET /api/funnel/campaign-spend — inversión en Meta y Google (últimos 12 meses). */
export const getCampaignSpend = asyncHandler(async (req, res) => {
  const spend = await MarketingSpend.find({ channel: { $in: PAID_CHANNELS } })
    .sort({ month: -1, channel: 1 })
    .limit(24)
    .lean();
  res.json({ success: true, data: { spend } });
});

export const campaignSpendSchema = spendSchema.extend({ channel: z.enum(PAID_CHANNELS) });

/** PUT /api/funnel/campaign-spend — la agencia registra lo invertido en pauta (Meta / Google). */
export const putCampaignSpend = asyncHandler(async (req, res) => {
  const { month, channel, amountMXN, note } = req.body;
  await MarketingSpend.updateOne(
    { month, channel },
    { $set: { amountMXN, note: note || (isAgency(req) ? 'Capturado por la agencia' : '') } },
    { upsert: true }
  );
  res.json({ success: true, data: { ok: true } });
});

/** GET /api/funnel/offline-conversions.csv — archivo para "Cargas" de Google Ads. */
export const getOfflineConversions = asyncHandler(async (req, res) => {
  const { from, to } = rangeOf(req.query);
  const { csv } = await offlineConversionsCsv({ from, to });
  const day = (d) => d.toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="conversiones-google-${day(from)}-a-${day(to)}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(csv);
});

/** POST /api/funnel/report — envía el reporte semanal ahora (prueba). */
export const sendReportNow = asyncHandler(async (req, res) => {
  const result = await sendWeeklyReport();
  if (result.skipped) throw ApiError.badRequest('Configura FUNNEL_REPORT_EMAILS en Render para enviar el reporte.');
  res.json({ success: true, data: result });
});
