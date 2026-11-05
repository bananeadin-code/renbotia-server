import { asyncHandler } from '../utils/asyncHandler.js';
import { Plan } from '../models/Plan.js';
import { CREDIT_PACKS, planHighlights } from '../config/constants.js';
import { env } from '../config/env.js';
import { annualInfo, pricingConfig } from '../services/pricing.service.js';

/**
 * Lista los planes activos (para la página de precios) y los paquetes de
 * créditos disponibles. Ruta pública.
 */
export const listPlans = asyncHandler(async (req, res) => {
  const docs = await Plan.find({ isActive: true }).sort({ priceMXN: 1 }).lean();
  const channels = { messenger: env.facebook.messengerEnabled, instagram: env.facebook.instagramEnabled };
  const now = new Date();
  const plans = docs.map((p) => ({
    ...p,
    highlights: planHighlights(p.highlights, channels),
    // Anual: precio de hoy (fundador o normal), equivalente mensual y ahorro.
    annual: annualInfo(p.key, now),
  }));
  res.json({
    success: true,
    data: { plans, creditPacks: CREDIT_PACKS, pricing: pricingConfig(now) },
  });
});
