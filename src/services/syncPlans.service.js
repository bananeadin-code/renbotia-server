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

// Textos por defecto ANTERIORES (con tokens y "agendan citas" sin aclarar que es
// Elite). Si el admin nunca los editó, se cambian por los defaults nuevos del
// modelo; si los editó, se respetan (los límites vigentes igual le llegan al
// asistente por planLimitsText()).
const OLD_DEFAULTS = {
  basePricing:
    'Free $0 (50,000 tokens, sin tarjeta) · Pro $479 MXN/mes (1,000,000 tokens) · Elite $999 MXN/mes (5,000,000 tokens + gestión de citas). También hay paquetes de créditos extra.',
  faqs: {
    '¿Qué es RenBotIA?':
      'RenBotIA crea asistentes de WhatsApp con inteligencia artificial para tu negocio: responden dudas, agendan citas y captan clientes 24/7, entrenados con tu propia información.',
    '¿Cuánto cuesta?':
      'Hay un plan Free gratis con 50,000 tokens para probar sin tarjeta. Pro cuesta $479 MXN/mes (1 millón de tokens) y Elite $999 MXN/mes (5 millones + gestión de citas). También puedes comprar paquetes de créditos extra.',
  },
};
const sameText = (current, old) => current && rewritePlanPrices(current) === rewritePlanPrices(old);

async function syncSiteAssistantPrices() {
  const doc = await SiteAssistant.findOne();
  if (!doc) return;
  let dirty = false;
  const defaults = SiteAssistant.schema.path('faqs').defaultValue?.() || [];
  if (sameText(doc.businessInfo?.basePricing, OLD_DEFAULTS.basePricing)) {
    doc.businessInfo.basePricing = SiteAssistant.schema.path('businessInfo.basePricing').defaultValue;
    dirty = true;
  }
  for (const f of doc.faqs || []) {
    const old = OLD_DEFAULTS.faqs[f.question];
    const fresh = defaults.find((d) => d.question === f.question);
    if (old && fresh && sameText(f.answer, old)) {
      f.answer = fresh.answer;
      dirty = true;
    }
  }
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
