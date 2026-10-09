import { z } from 'zod';
import { setSessionContext, tokensForSession } from '../services/session.service.js';
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
 * Siempre crea la cuenta en Free: para un plan de pago, el asistente crea primero
 * la cuenta y luego abre el pago (tarjeta guardada → cobro → mejora de plan).
 */
export const completeOnboarding = asyncHandler(async (req, res) => {
  const { business, planKey, botConfig } = req.body;

  // Seguridad: el onboarding SOLO crea cuentas Free. Los planes de pago se
  // activan únicamente al confirmar un cobro real (billing/confirm), nunca aquí;
  // si no, cualquiera podría activarse Pro/Elite gratis llamando a la API.
  if (planKey !== 'free') {
    throw new ApiError(402, 'Los planes de pago se activan al confirmar el pago.', {
      code: 'PAYMENT_REQUIRED',
    });
  }

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

  // La sesión (de cuenta, sin negocio) pasa a ser la del DUEÑO de este negocio, y
  // se entregan tokens nuevos con ese contexto.
  let accessToken = null;
  if (req.sessionId && req.sessionContext?.kind === 'account') {
    await setSessionContext(req.sessionId, { kind: 'owner', business: bundle.business._id });
    accessToken = (await tokensForSession(req.user, req.sessionId))?.accessToken || null;
  }

  res.status(201).json({ success: true, data: { ...bundle, accessToken } });
});
