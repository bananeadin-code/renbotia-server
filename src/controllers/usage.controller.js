import { asyncHandler } from '../utils/asyncHandler.js';
import { UsageLog } from '../models/UsageLog.js';
import { Subscription } from '../models/Subscription.js';
import { ChatSimulation } from '../models/ChatSimulation.js';
import { ManagedRecord } from '../models/ManagedRecord.js';
import { applyLazyReset, computeBalance } from '../services/token.service.js';

/**
 * Resumen de consumo para el dashboard:
 *  - balance actual (usados vs disponibles)
 *  - serie diaria de tokens de los últimos N días (para la gráfica)
 */
export const getUsageSummary = asyncHandler(async (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 90);
  const since = new Date();
  since.setDate(since.getDate() - days);

  const subscription = await Subscription.findOne({ business: req.businessId }).populate('plan');
  if (subscription) await applyLazyReset(subscription);
  const balance = subscription ? computeBalance(subscription) : null;

  // Serie diaria agregada (tokens totales por día).
  const daily = await UsageLog.aggregate([
    { $match: { business: req.businessId, date: { $gte: since } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
        totalTokens: { $sum: '$totalTokens' },
        inputTokens: { $sum: '$inputTokens' },
        outputTokens: { $sum: '$outputTokens' },
      },
    },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, date: '$_id', totalTokens: 1, inputTokens: 1, outputTokens: 1 } },
  ]);

  res.json({ success: true, data: { balance, daily, rangeDays: days } });
});

/**
 * GET /api/usage/impact
 * Reporte de IMPACTO/ROI del bot (retención): cuánto trabajó el bot este mes.
 * Datos duros (conversaciones, respuestas del bot, trabajo captado) + una
 * estimación honesta de tiempo ahorrado (~2 min por mensaje respondido).
 */
export const getImpactSummary = asyncHandler(async (req, res) => {
  const businessId = req.businessId;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [conversations, botAgg, recordsCaptured, conversationsTotal] = await Promise.all([
    ChatSimulation.countDocuments({ business: businessId, updatedAt: { $gte: startOfMonth } }),
    ChatSimulation.aggregate([
      { $match: { business: businessId } },
      { $unwind: '$messages' },
      { $match: { 'messages.role': 'assistant', 'messages.timestamp': { $gte: startOfMonth } } },
      { $count: 'n' },
    ]),
    ManagedRecord.countDocuments({ business: businessId, createdAt: { $gte: startOfMonth } }),
    ChatSimulation.countDocuments({ business: businessId }),
  ]);

  const botReplies = botAgg[0]?.n || 0;
  const hoursSaved = Math.round((botReplies * 2) / 60 * 10) / 10; // ~2 min por respuesta

  res.json({
    success: true,
    data: {
      month: now.toLocaleDateString('es-MX', { month: 'long', year: 'numeric' }),
      conversations,
      botReplies,
      recordsCaptured,
      hoursSaved,
      conversationsTotal,
    },
  });
});

/**
 * GET /api/usage/analytics
 * Analíticas del cliente sobre la actividad de su bot: tendencia mensual
 * (conversaciones y trabajo captado, 6 meses), desglose de trabajo por tipo,
 * reparto por canal, etiquetas más usadas, leads calientes abiertos y una
 * estimación del tiempo de primera respuesta del bot. Datos duros del propio
 * negocio (aislados por tenant); las estimaciones se marcan como tales en la UI.
 */
export const getAnalytics = asyncHandler(async (req, res) => {
  const businessId = req.businessId;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  const [convMonthly, recMonthly, recByType, channels, msgAgg, hotLeadsOpen, topTagsAgg, recordsThisMonth, recentConvs] =
    await Promise.all([
      // Conversaciones NUEVAS por mes (por fecha de creación).
      ChatSimulation.aggregate([
        { $match: { business: businessId, createdAt: { $gte: sixMonthsAgo } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } }, n: { $sum: 1 } } },
      ]),
      // Trabajo captado por mes.
      ManagedRecord.aggregate([
        { $match: { business: businessId, createdAt: { $gte: sixMonthsAgo } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } }, n: { $sum: 1 } } },
      ]),
      // Desglose de trabajo por tipo (últimos 90 días, más representativo).
      ManagedRecord.aggregate([
        { $match: { business: businessId, createdAt: { $gte: ninetyDaysAgo } } },
        { $group: { _id: '$type', n: { $sum: 1 } } },
      ]),
      // Reparto de conversaciones por canal (histórico).
      ChatSimulation.aggregate([
        { $match: { business: businessId } },
        { $group: { _id: '$channel', n: { $sum: 1 } } },
      ]),
      // Mensajes de ESTE mes por rol/origen (para respuestas del bot vs. persona).
      ChatSimulation.aggregate([
        { $match: { business: businessId } },
        { $unwind: '$messages' },
        { $match: { 'messages.timestamp': { $gte: startOfMonth } } },
        { $group: { _id: { role: '$messages.role', via: '$messages.via' }, n: { $sum: 1 } } },
      ]),
      // Leads calientes abiertos (oportunidades pendientes de seguimiento).
      ChatSimulation.countDocuments({ business: businessId, hotLead: true }),
      // Etiquetas más usadas por el agente.
      ChatSimulation.aggregate([
        { $match: { business: businessId, tags: { $ne: [] } } },
        { $unwind: '$tags' },
        { $group: { _id: '$tags', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 6 },
      ]),
      ManagedRecord.countDocuments({ business: businessId, createdAt: { $gte: startOfMonth } }),
      // Muestra reciente para estimar el tiempo de primera respuesta del bot.
      ChatSimulation.find({ business: businessId, createdAt: { $gte: sixtyDaysAgo } })
        .select('messages')
        .sort({ createdAt: -1 })
        .limit(300)
        .lean(),
    ]);

  // Serie mensual de 6 meses (incluye meses sin actividad, en cero).
  const MONTH_LABELS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const convMap = Object.fromEntries(convMonthly.map((d) => [d._id, d.n]));
  const recMap = Object.fromEntries(recMonthly.map((d) => [d._id, d.n]));
  const monthly = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    monthly.push({
      month: key,
      label: MONTH_LABELS[d.getMonth()],
      conversations: convMap[key] || 0,
      records: recMap[key] || 0,
    });
  }

  // Respuestas de ESTE mes: bot vs. persona (agente).
  let botReplies = 0;
  let agentReplies = 0;
  let incomingMessages = 0;
  for (const g of msgAgg) {
    if (g._id.role === 'user') incomingMessages += g.n;
    else if (g._id.role === 'assistant') {
      if (g._id.via === 'agent') agentReplies += g.n;
      else botReplies += g.n;
    }
  }

  // Tiempo de PRIMERA respuesta del bot (aprox): minutos entre el primer mensaje
  // del cliente y la primera respuesta automática. Ignora respuestas humanas y
  // esperas > 24 h (conversaciones dormidas) para no distorsionar el promedio.
  let sum = 0;
  let cnt = 0;
  for (const c of recentConvs) {
    const msgs = c.messages || [];
    const firstUser = msgs.find((m) => m.role === 'user');
    if (!firstUser) continue;
    const firstBot = msgs.find(
      (m) => m.role === 'assistant' && m.via !== 'agent' && new Date(m.timestamp) >= new Date(firstUser.timestamp)
    );
    if (!firstBot) continue;
    const mins = (new Date(firstBot.timestamp) - new Date(firstUser.timestamp)) / 60000;
    if (mins < 0 || mins > 1440) continue;
    sum += mins;
    cnt += 1;
  }
  const avgResponseMins = cnt ? Math.round((sum / cnt) * 10) / 10 : null;

  const CH_LABELS = { simulator: 'Simulador', whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Messenger' };
  const REC_LABELS = { cita: 'Citas', reservacion: 'Reservaciones', pedido: 'Pedidos', prospecto: 'Prospectos' };

  res.json({
    success: true,
    data: {
      month: now.toLocaleDateString('es-MX', { month: 'long', year: 'numeric' }),
      monthly,
      recordsByType: recByType.map((d) => ({ type: d._id, label: REC_LABELS[d._id] || d._id, count: d.n })),
      channels: channels.map((d) => ({ channel: d._id || 'simulator', label: CH_LABELS[d._id] || d._id || 'Simulador', count: d.n })),
      topTags: topTagsAgg.map((d) => ({ tag: d._id, count: d.n })),
      totals: {
        conversationsThisMonth: monthly[5].conversations,
        recordsThisMonth,
        botReplies,
        agentReplies,
        incomingMessages,
        hotLeadsOpen,
        avgResponseMins,
      },
    },
  });
});
