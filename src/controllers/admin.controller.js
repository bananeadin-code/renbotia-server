import { asyncHandler } from '../utils/asyncHandler.js';
import { Business } from '../models/Business.js';
import { Subscription } from '../models/Subscription.js';
import { UsageLog } from '../models/UsageLog.js';
import { estimateCostUSD, usdToMxn } from '../utils/pricing.js';

/**
 * Vista global para el admin: todos los negocios con su dueño, plan, consumo de
 * tokens y COSTO REAL estimado (USD/MXN) según input/output/caché. Clave para
 * monitorear costos reales de la API antes de prod.
 */
export const listAllBusinesses = asyncHandler(async (req, res) => {
  const businesses = await Business.find()
    .populate('owner', 'name email')
    .sort({ createdAt: -1 })
    .lean();

  // Suma solo los tokens REALES (simulated=false) para el costo, y aparte los de
  // DEMO/seed (simulated=true). Así el costo cuadra con la consola de Anthropic.
  const notSim = (field) => ({ $sum: { $cond: [{ $eq: ['$simulated', true] }, 0, `$${field}`] } });
  const [subscriptions, usageByBusiness] = await Promise.all([
    Subscription.find().populate('plan', 'name key monthlyTokenLimit').lean(),
    UsageLog.aggregate([
      {
        $group: {
          _id: '$business',
          // Reales (para costo)
          inputTokens: notSim('inputTokens'),
          outputTokens: notSim('outputTokens'),
          cacheReadTokens: notSim('cacheReadTokens'),
          cacheCreationTokens: notSim('cacheCreationTokens'),
          realTokens: notSim('totalTokens'),
          realRequests: { $sum: { $cond: [{ $eq: ['$simulated', true] }, 0, 1] } },
          // Demo (solo volumen, sin costo)
          demoTokens: { $sum: { $cond: [{ $eq: ['$simulated', true] }, '$totalTokens', 0] } },
        },
      },
    ]),
  ]);

  const subByBusiness = new Map(subscriptions.map((s) => [String(s.business), s]));
  const usageMap = new Map(usageByBusiness.map((u) => [String(u._id), u]));

  const rows = businesses.map((b) => {
    const sub = subByBusiness.get(String(b._id));
    const usage = usageMap.get(String(b._id));
    // El costo se estima SOLO con los tokens reales.
    const costUsd = usage ? estimateCostUSD(usage) : 0;
    return {
      id: b._id,
      name: b.name,
      industry: b.industry,
      status: b.status,
      owner: b.owner ? { name: b.owner.name, email: b.owner.email } : null,
      plan: sub?.plan?.name || null,
      planKey: sub?.plan?.key || null,
      tokensUsedThisPeriod: sub?.tokensUsedThisPeriod ?? 0,
      extraTokens: sub?.extraTokens ?? 0,
      realTokens: usage?.realTokens ?? 0,
      demoTokens: usage?.demoTokens ?? 0,
      totalRequests: usage?.realRequests ?? 0,
      costUsd,
      costMxn: usdToMxn(costUsd),
      createdAt: b.createdAt,
    };
  });

  const totals = {
    businesses: rows.length,
    realTokensAllTime: rows.reduce((acc, r) => acc + r.realTokens, 0),
    demoTokensAllTime: rows.reduce((acc, r) => acc + r.demoTokens, 0),
    costUsdAllTime: rows.reduce((acc, r) => acc + r.costUsd, 0),
    costMxnAllTime: rows.reduce((acc, r) => acc + r.costMxn, 0),
  };

  res.json({ success: true, data: { businesses: rows, totals } });
});
