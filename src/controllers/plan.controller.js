import { asyncHandler } from '../utils/asyncHandler.js';
import { Plan } from '../models/Plan.js';
import { CREDIT_PACKS } from '../config/constants.js';

/**
 * Lista los planes activos (para la página de precios) y los paquetes de
 * créditos disponibles. Ruta pública.
 */
export const listPlans = asyncHandler(async (req, res) => {
  const plans = await Plan.find({ isActive: true }).sort({ priceMXN: 1 });
  res.json({
    success: true,
    data: { plans, creditPacks: CREDIT_PACKS },
  });
});
