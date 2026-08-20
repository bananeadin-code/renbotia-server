import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { BotConfig } from '../models/BotConfig.js';
import { Subscription } from '../models/Subscription.js';
import { ApiError } from '../utils/ApiError.js';
import { sanitizeBotConfigForPlan, getPlanLimits } from '../utils/planGating.js';
import { validateTrainingConfig } from '../services/validation.service.js';
import { logAudit } from '../services/audit.service.js';

const faqSchema = z.object({
  question: z.string().min(2, 'La pregunta es muy corta'),
  answer: z.string().min(2, 'La respuesta es muy corta'),
});

// La URL puede ser http(s) o un data URI de imagen (archivo subido y comprimido
// en el cliente). Se permite longitud grande para el data URI.
const imageUrl = z
  .string()
  .max(1_500_000)
  .refine((v) => v === '' || /^https?:\/\//i.test(v) || /^data:image\//i.test(v), {
    message: 'La imagen debe ser una URL http(s) o un archivo de imagen.',
  });

const imageSchema = z.object({
  label: z.string().max(80).optional().default(''),
  url: imageUrl.optional().default(''),
  context: z.string().max(300).optional().default(''),
});

export const updateBotConfigSchema = z.object({
  botName: z.string().min(1).max(60).optional(),
  tone: z.enum(['formal', 'cercano', 'neutral', 'tecnico']).optional(),
  systemPrompt: z.string().max(4000).optional(),
  faqs: z.array(faqSchema).optional(),
  businessInfo: z
    .object({
      hours: z.string().max(200).optional(),
      location: z.string().max(200).optional(),
      services: z.array(z.string().max(120)).optional(),
      basePricing: z.string().max(500).optional(),
    })
    .optional(),
  extraContext: z.string().max(6000).optional(),
  images: z.array(imageSchema).max(15).optional(),
});

async function getConfigOrThrow(businessId) {
  const config = await BotConfig.findOne({ business: businessId });
  if (!config) {
    throw ApiError.notFound('No hay configuración de bot para este negocio');
  }
  return config;
}

async function planKeyForBusiness(businessId) {
  const sub = await Subscription.findOne({ business: businessId }).populate('plan', 'key');
  return sub?.plan?.key || 'free';
}

/**
 * Devuelve la configuración del bot + los límites del plan (para que el panel
 * muestre/oculte campos según Free/Pro/Elite).
 */
export const getBotConfig = asyncHandler(async (req, res) => {
  const config = await getConfigOrThrow(req.businessId);
  const planKey = await planKeyForBusiness(req.businessId);
  res.json({
    success: true,
    data: { botConfig: config, planKey, limits: getPlanLimits(planKey) },
  });
});

/**
 * Actualiza la configuración del bot. SANEA los campos contra el plan del
 * negocio (barrera de seguridad: aunque el cliente mande campos no permitidos,
 * aquí se recortan/ignoran).
 */
export const updateBotConfig = asyncHandler(async (req, res) => {
  const planKey = await planKeyForBusiness(req.businessId);
  const safe = sanitizeBotConfigForPlan(req.body, planKey);

  // Validación estricta: cada campo para su propósito (anti-abuso / inyección).
  const issues = await validateTrainingConfig(safe);
  if (issues.length) {
    throw new ApiError(422, 'Algunos campos no se usan para lo que son', {
      code: 'CONTENT_REJECTED',
      issues,
    });
  }

  const config = await BotConfig.findOneAndUpdate(
    { business: req.businessId },
    { $set: safe },
    { new: true, runValidators: true }
  );
  if (!config) {
    throw ApiError.notFound('No hay configuración de bot para este negocio');
  }
  void logAudit({
    businessId: req.businessId,
    userId: req.userId,
    action: 'botconfig.update',
    summary: 'Actualizó el entrenamiento del bot (FAQs, tono o datos).',
  });
  res.json({ success: true, data: { botConfig: config, planKey, limits: getPlanLimits(planKey) } });
});
