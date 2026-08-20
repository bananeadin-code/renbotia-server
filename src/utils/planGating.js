import { PLAN_LIMITS } from '../config/constants.js';

export function getPlanLimits(planKey) {
  return PLAN_LIMITS[planKey] || PLAN_LIMITS.free;
}

/**
 * Ajusta una BotConfig entrante a lo que permite el plan. Es la barrera de
 * seguridad del servidor: aunque el frontend oculte campos, aquí se recortan.
 *
 * @param {object} cfg - datos de bot (faqs, tone, systemPrompt, extraContext, images, ...)
 * @param {string} planKey - 'free' | 'pro' | 'elite'
 * @returns {object} copia saneada
 */
export function sanitizeBotConfigForPlan(cfg = {}, planKey = 'free') {
  const limits = getPlanLimits(planKey);
  const out = { ...cfg };

  // FAQs: recorta al máximo del plan (null = ilimitado)
  if (Array.isArray(out.faqs) && limits.maxFaqs != null) {
    out.faqs = out.faqs.slice(0, limits.maxFaqs);
  }

  // Personalidad (instrucciones): solo Pro/Elite
  if (!limits.personality) out.systemPrompt = '';

  // Tono: Free siempre neutral
  if (!limits.tone) out.tone = 'neutral';

  // Contexto ampliado: solo Pro/Elite
  if (!limits.extraContext) out.extraContext = '';

  // Imágenes: solo Elite (recorta al máximo)
  if (!limits.maxImages) {
    out.images = [];
  } else if (Array.isArray(out.images)) {
    out.images = out.images.slice(0, limits.maxImages);
  }

  return out;
}
