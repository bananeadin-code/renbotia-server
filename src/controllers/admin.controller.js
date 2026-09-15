import { asyncHandler } from '../utils/asyncHandler.js';
import { Business } from '../models/Business.js';
import { Subscription } from '../models/Subscription.js';
import { UsageLog } from '../models/UsageLog.js';
import { Payment } from '../models/Payment.js';
import { env } from '../config/env.js';
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

/* ─── Control fiscal (RESICO PF) ───────────────────────────────────────────── */

const MONTHS_ES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Tasa mensual de ISR de RESICO Persona Física (progresiva por ingreso del mes).
 * Fuente: tabla del Art. 113-E LISR. ESTIMACIÓN; el cálculo oficial lo hace el
 * contador/SAT (aquí no restamos IVA acreditable ni deducciones).
 */
function isrRate(monthly) {
  if (monthly <= 25000) return 0.01;
  if (monthly <= 50000) return 0.011;
  if (monthly <= 83333.33) return 0.015;
  if (monthly <= 208333.33) return 0.02;
  return 0.025;
}
// IVA estimado asumiendo que el precio YA incluye IVA (16%): parte que trasladaste.
const ivaEstimate = (income) => round2(income - income / 1.16);

/**
 * GET /api/admin/fiscal — status de ingresos del sitio y estimación de impuestos
 * según el régimen del operador (RESICO PF). Ingresos = pagos completados (Stripe).
 * En beta suele ir en ceros. Es un APOYO de control, NO un cálculo oficial.
 */
export const getFiscalSummary = asyncHandler(async (req, res) => {
  const grouped = await Payment.aggregate([
    { $match: { status: 'completed' } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: 'America/Mexico_City' } },
        income: { $sum: '$amountMXN' },
        payments: { $sum: 1 },
      },
    },
  ]);
  const byYm = new Map(grouped.map((r) => [r._id, r]));

  // Mes actual en zona horaria de México.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  const curY = Number(parts.find((p) => p.type === 'year').value);
  const curM = Number(parts.find((p) => p.type === 'month').value);

  // Últimos 12 meses (incluye meses en cero) del más reciente al más viejo.
  const months = [];
  for (let i = 0; i < 12; i++) {
    let m = curM - i;
    let y = curY;
    while (m <= 0) {
      m += 12;
      y -= 1;
    }
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    const income = round2(byYm.get(ym)?.income || 0);
    months.push({
      ym,
      label: `${MONTHS_ES[m - 1]} ${y}`,
      income,
      payments: byYm.get(ym)?.payments || 0,
      isr: round2(income * isrRate(income)),
      iva: ivaEstimate(income),
    });
  }

  const current = months[0];
  // Vencimiento de la declaración del mes actual: día 17 del mes siguiente.
  let dm = curM + 1;
  let dy = curY;
  if (dm > 12) {
    dm = 1;
    dy += 1;
  }

  const allTime = grouped.reduce(
    (a, r) => ({ income: a.income + r.income, payments: a.payments + r.payments }),
    { income: 0, payments: 0 }
  );
  const yearIncome = months
    .filter((mo) => mo.ym.startsWith(String(curY)))
    .reduce((a, mo) => a + mo.income, 0);

  res.json({
    success: true,
    data: {
      beta: env.betaMode,
      regime: { name: 'RESICO Persona Física', code: '626' },
      current: {
        ...current,
        isrRatePct: round2(isrRate(current.income) * 100),
        dueLabel: `17 de ${MONTHS_ES[dm - 1]} de ${dy}`,
      },
      year: { year: curY, income: round2(yearIncome) },
      allTime: { income: round2(allTime.income), payments: allTime.payments },
      months,
      obligations: [
        { clave: '841', name: 'Pago provisional de ISR', freq: 'Mensual', when: 'Día 17 del mes siguiente' },
        { clave: '849', name: 'Pago definitivo de IVA', freq: 'Mensual', when: 'Día 17 del mes siguiente' },
        { clave: '842', name: 'Declaración anual de ISR', freq: 'Anual', when: 'Abril del año siguiente' },
      ],
    },
  });
});
