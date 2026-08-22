import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { SiteAssistant } from '../models/SiteAssistant.js';
import { buildSystemPrompt } from '../services/promptBuilder.service.js';
import { generateReply } from '../services/claude.service.js';
import { logger } from '../utils/logger.js';

/**
 * Asistente IA del SITIO: soporte + guía + prueba viva. Público (sin auth) para el
 * widget flotante; configurable por el admin desde el panel. Reutiliza
 * buildSystemPrompt → hereda el blindaje anti-inyección del producto. No descuenta
 * tokens de ningún negocio (es costo de marketing de RenBotIA); se acota con
 * demoLimiter + ventana de historial.
 */

// "Negocio" que representa a RenBotIA para el prompt.
const SITE_BUSINESS = {
  name: 'RenBotIA',
  industry: 'otro',
  industryOther: 'Plataforma de bots de WhatsApp con IA',
};

function toBotConfig(cfg) {
  return {
    botName: cfg.botName,
    tone: cfg.tone,
    systemPrompt: '',
    extraContext: cfg.extraContext,
    businessInfo: {
      hours: cfg.businessInfo?.hours || '',
      location: cfg.businessInfo?.location || '',
      services: cfg.businessInfo?.services || [],
      basePricing: cfg.businessInfo?.basePricing || '',
    },
    faqs: (cfg.faqs || []).filter((f) => f.question && f.answer),
    images: [],
  };
}

/* ─── Público ─────────────────────────────────────────────────────────────── */

/** GET /api/site-assistant/config — lo que el widget necesita para renderizarse. */
export const getPublicConfig = asyncHandler(async (req, res) => {
  const cfg = await SiteAssistant.getSingleton();
  res.json({
    success: true,
    data: {
      enabled: cfg.enabled,
      botName: cfg.botName,
      welcomeMessage: cfg.welcomeMessage,
      quickReplies: cfg.quickReplies || [],
    },
  });
});

export const messageSchema = z.object({
  message: z.string().min(1, 'Escribe un mensaje').max(500),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(2000) }))
    .max(12)
    .optional()
    .default([]),
});

/** POST /api/site-assistant/message — responde como el asistente del sitio. */
export const siteAssistantMessage = asyncHandler(async (req, res) => {
  const cfg = await SiteAssistant.getSingleton();
  if (!cfg.enabled) {
    return res.json({
      success: true,
      data: { reply: 'El asistente no está disponible por ahora. Escríbenos y con gusto te ayudamos.' },
    });
  }

  const { message, history } = req.body;
  const system = buildSystemPrompt(toBotConfig(cfg), SITE_BUSINESS);
  const messages = [...history.slice(-8), { role: 'user', content: message }];

  try {
    const { text } = await generateReply({ system, messages });
    res.json({ success: true, data: { reply: text } });
  } catch (err) {
    if (err.statusCode === 503) throw err; // problema de configuración (API key): que lo vea el admin
    logger.warn(`Asistente del sitio: IA no disponible; se degrada. ${err.message}`);
    res.json({
      success: true,
      data: {
        reply:
          'Ahora mismo no puedo responder. Puedes ver los planes en /precios o crear una cuenta gratis para empezar.',
        degraded: true,
      },
    });
  }
});

/* ─── Admin ───────────────────────────────────────────────────────────────── */

/** GET /api/admin/site-assistant — configuración completa (solo admin). */
export const getAdminConfig = asyncHandler(async (req, res) => {
  const cfg = await SiteAssistant.getSingleton();
  res.json({ success: true, data: { config: cfg } });
});

export const updateSchema = z.object({
  botName: z.string().min(1).max(60).optional(),
  tone: z.enum(['formal', 'cercano', 'neutral', 'tecnico']).optional(),
  welcomeMessage: z.string().min(1).max(500).optional(),
  quickReplies: z.array(z.string().max(80)).max(6).optional(),
  businessInfo: z
    .object({
      hours: z.string().max(200).optional(),
      location: z.string().max(200).optional(),
      services: z.array(z.string().max(160)).max(12).optional(),
      basePricing: z.string().max(600).optional(),
    })
    .optional(),
  faqs: z
    .array(z.object({ question: z.string().max(200), answer: z.string().max(1000) }))
    .max(20)
    .optional(),
  extraContext: z.string().max(2000).optional(),
  enabled: z.boolean().optional(),
});

/** PUT /api/admin/site-assistant — actualiza la configuración (solo admin). */
export const updateAdminConfig = asyncHandler(async (req, res) => {
  const cfg = await SiteAssistant.getSingleton();
  Object.assign(cfg, req.body);
  await cfg.save();
  res.json({ success: true, data: { config: cfg } });
});
