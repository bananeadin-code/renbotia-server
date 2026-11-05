import { PLANS } from '../config/constants.js';
import { Plan } from '../models/Plan.js';
import { SiteAssistant } from '../models/SiteAssistant.js';
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
  await syncSiteAssistantPrices().catch((err) => logger.warn(`Precios del asistente del sitio: ${err.message}`));
  return { changed };
}

/**
 * El asistente del sitio guarda su texto en la base (lo edita el admin), así que
 * un cambio de precio en el código no le llegaría. Reescribe solo las menciones
 * "Pro $NNN" / "Pro cuesta $NNN" (y Elite) con el precio vigente. Idempotente.
 */
export function rewritePlanPrices(text) {
  if (!text) return text;
  let out = String(text);
  for (const p of PLANS) {
    if (!p.priceMXN) continue;
    const re = new RegExp(String.raw`(\b${p.name}(?: cuesta)?:? \$)\d[\d,]*`, 'g');
    out = out.replace(re, `$1${p.priceMXN.toLocaleString('en-US')}`);
  }
  return out;
}

async function syncSiteAssistantPrices() {
  const doc = await SiteAssistant.findOne();
  if (!doc) return;
  let dirty = false;
  const base = doc.businessInfo?.basePricing;
  const nextBase = rewritePlanPrices(base);
  if (base && nextBase !== base) {
    doc.businessInfo.basePricing = nextBase;
    dirty = true;
  }
  for (const f of doc.faqs || []) {
    const next = rewritePlanPrices(f.answer);
    if (f.answer && next !== f.answer) {
      f.answer = next;
      dirty = true;
    }
  }
  if (dirty) {
    await doc.save();
    logger.info('Asistente del sitio: precios de planes actualizados.');
  }
}
