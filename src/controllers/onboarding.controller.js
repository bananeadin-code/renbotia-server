import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { Business } from '../models/Business.js';
import { Membership } from '../models/Membership.js';
import { provisionBusiness } from '../services/business.service.js';
import { sanitizeBotConfigForPlan } from '../utils/planGating.js';
import { validateTrainingConfig } from '../services/validation.service.js';
import { ApiError } from '../utils/ApiError.js';

const faqSchema = z.object({
  question: z.string().min(2),
  answer: z.string().min(2),
});

export const onboardingSchema = z.object({
  business: z.object({
    // Opcional: el usuario puede omitir los datos del negocio en el onboarding y
    // completarlos después en el panel (provisionBusiness usa "Mi negocio" si viene vacío).
    name: z.string().max(80).optional().default(''),
    industry: z.enum(['legal', 'contable', 'consultoria', 'agencia', 'otro']).default('otro'),
    industryOther: z.string().max(60).optional().default(''),
    whatsappNumber: z.string().max(30).optional().default(''),
  }),
  planKey: z.enum(['free', 'pro', 'elite']),
  botConfig: z
    .object({
      botName: z.string().min(1).max(60).optional(),
      tone: z.enum(['formal', 'cercano', 'neutral', 'tecnico']).optional(),
      faqs: z.array(faqSchema).max(10).optional(),
      businessInfo: z
        .object({
          hours: z.string().max(200).optional(),
          location: z.string().max(200).optional(),
          services: z.array(z.string().max(120)).optional(),
          basePricing: z.string().max(500).optional(),
        })
        .optional(),
    })
    .optional()
    .default({}),
});

/**
 * Estado del onboarding: indica si el usuario ya tiene negocio.
 * El frontend lo usa para decidir si mostrar el wizard o el dashboard.
 */
export const getOnboardingStatus = asyncHandler(async (req, res) => {
  // Tiene negocio si es dueño O si es colaborador invitado (membresía).
  const owned = await Business.findOne({ owner: req.userId }).select('_id');
  const member = owned ? null : await Membership.findOne({ user: req.userId }).select('_id');
  res.json({ success: true, data: { hasBusiness: Boolean(owned || member) } });
});

/**
 * Completa el onboarding creando Business + Subscription + BotConfig.
 *
 * NOTA (Fase 5): en producción este paso se dispara al confirmar el checkout de
 * Stripe. Aquí activamos directamente (simulado) para validar el flujo en local.
 * Reutiliza el mismo provisionBusiness que usará el webhook de Stripe.
 */
export const completeOnboarding = asyncHandler(async (req, res) => {
  const { business, planKey, botConfig } = req.body;

  // Sanea contra el plan elegido (p.ej. Free = tono neutral) y valida el uso
  // correcto de cada campo antes de crear el negocio.
  const safeBotConfig = sanitizeBotConfigForPlan(botConfig || {}, planKey);
  const issues = await validateTrainingConfig(safeBotConfig);
  if (issues.length) {
    throw new ApiError(422, 'Algunos campos no se usan para lo que son', {
      code: 'CONTENT_REJECTED',
      issues,
    });
  }

  const bundle = await provisionBusiness({
    owner: req.userId,
    planKey,
    business,
    botConfig: safeBotConfig,
  });

  res.status(201).json({ success: true, data: bundle });
});
