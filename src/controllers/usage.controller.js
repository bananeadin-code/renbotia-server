import { asyncHandler } from '../utils/asyncHandler.js';
import { UsageLog } from '../models/UsageLog.js';
import { Subscription } from '../models/Subscription.js';
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
