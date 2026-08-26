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
