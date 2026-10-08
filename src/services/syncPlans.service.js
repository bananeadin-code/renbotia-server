import { PLANS } from '../config/constants.js';
import { Plan } from '../models/Plan.js';
import { logger } from '../utils/logger.js';

/**
 * Sincroniza los planes de la base con los del código (constants.PLANS): nombre,
 * precio, límite de tokens y beneficios. El COBRO usa el precio del código; si
 * la base quedara distinta, el cliente vería un precio y pagaría otro. Por eso
 * se corre solo al arrancar (idempotente; no toca suscripciones ni negocios).
 */
export async function syncPlans() {
  let changed = 0;
  for (const p of PLANS) {
    const res = await Plan.updateOne(
      { key: p.key },
      {
        $set: {
          name: p.name,
          priceMXN: p.priceMXN,
          monthlyTokenLimit: p.monthlyTokenLimit,
          highlights: p.highlights,
          isActive: true,
        },
      },
      { upsert: true }
    );
    if (res.modifiedCount || res.upsertedCount) changed += 1;
  }
  if (changed) logger.info(`Planes sincronizados con el código (${changed} actualizado/s).`);
  return { changed };
}
