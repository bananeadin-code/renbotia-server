import { z } from 'zod';
import { runBotAudit, lastAudit } from '../services/botAudit.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { BotConfig } from '../models/BotConfig.js';
import { Subscription } from '../models/Subscription.js';
import { ApiError } from '../utils/ApiError.js';
import { sanitizeBotConfigForPlan, getPlanLimits } from '../utils/planGating.js';
import { validateTrainingConfig } from '../services/validation.service.js';
import { logAudit } from '../services/audit.service.js';
import { SCHEDULE_TIMEZONES } from '../utils/botAvailability.js';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

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
  quickReplies: z.array(z.string().max(300)).max(12).optional(),
  schedule: z
    .object({
      enabled: z.boolean(),
      timezone: z.enum(SCHEDULE_TIMEZONES),
      botMode: z.enum(['always', 'closed_only']),
      days: z
        .array(
          z.object({
            day: z.number().int().min(0).max(6),
            enabled: z.boolean(),
            open: z.string().regex(HHMM, 'Hora no válida'),
            close: z.string().regex(HHMM, 'Hora no válida'),
          })
        )
        .max(7),
      closedMessage: z.string().max(300).optional().default(''),
    })
    .refine((sc) => sc.days.every((d) => !d.enabled || d.open !== d.close), {
      message: 'La hora de apertura y de cierre no pueden ser iguales.',
      path: ['days'],
    })
    .refine((sc) => !sc.enabled || sc.days.some((d) => d.enabled), {
      message: 'Marca al menos un día de atención.',
      path: ['days'],
    })
    .optional(),
  followUp: z
    .object({
      enabled: z.boolean(),
      delayHours: z.number().int().min(1).max(20),
      mode: z.enum(['ai', 'custom']),
      message: z.string().max(500).optional().default(''),
      template: z
        .object({
          enabled: z.boolean(),
          name: z.string().max(512).optional().default(''),
          language: z.string().min(2).max(10).optional().default('es_MX'),
          delayHours: z.number().int().min(24).max(168),
          params: z.array(z.string().trim().max(300)).max(10).optional().default([]),
          nameFallback: z.string().trim().max(40).optional().default('cliente'),
        })
        .refine((t) => !t.enabled || t.name.trim().length > 0, {
          message: 'Elige la plantilla aprobada para el seguimiento.',
          path: ['name'],
        })
        .optional(),
    })
    .refine((f) => !f.enabled || f.mode !== 'custom' || f.message.trim().length >= 5, {
      message: 'Escribe el mensaje de seguimiento (mínimo 5 caracteres).',
      path: ['message'],
    })
    .optional(),
  images: z.array(imageSchema).max(30).optional(),
  documents: z
    .array(
      z.object({
        name: z.string().max(120).optional().default(''),
        text: z.string().max(20000).optional().default(''),
      })
    )
    .max(10)
    .optional(),
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

  // Seguimiento: se guarda por campo, para que actualizar una parte (p. ej. el
  // seguimiento normal) no borre la otra (la plantilla) si no viene en la petición.
  if (safe.followUp) {
    for (const [k, v] of Object.entries(safe.followUp)) safe[`followUp.${k}`] = v;
    delete safe.followUp;
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

/* ── Avisos temporales ("hoy cerramos a las 4") ─────────────────────────────── */

const activeNotices = (cfg) => {
  const now = Date.now();
  return (cfg?.notices || [])
    .filter((n) => !n.until || new Date(n.until).getTime() > now)
    .map((n) => ({ id: n._id, text: n.text, until: n.until, via: n.via, createdAt: n.createdAt }));
};

/** GET /api/botconfig/notices — avisos vigentes. */
export const listNotices = asyncHandler(async (req, res) => {
  const cfg = await BotConfig.findOne({ business: req.businessId }).select('notices').lean();
  res.json({ success: true, data: { notices: activeNotices(cfg) } });
});

export const noticeSchema = z.object({
  text: z.string().trim().min(3, 'Escribe el aviso').max(200),
  until: z.string().datetime().nullable().optional(),
});

/** POST /api/botconfig/notices — agrega un aviso (máx. 10 vigentes). */
export const addNotice = asyncHandler(async (req, res) => {
  const issues = await validateTrainingConfig({ extraContext: req.body.text });
  if (issues.length) {
    throw new ApiError(422, issues[0]?.reason || 'Ese aviso no parece información del negocio.', { code: 'CONTENT_REJECTED' });
  }
  const until = req.body.until ? new Date(req.body.until) : null;
  if (until && until.getTime() <= Date.now()) throw ApiError.badRequest('La fecha de vencimiento ya pasó.');
  const cfg = await BotConfig.findOne({ business: req.businessId });
  if (!cfg) throw ApiError.notFound('El bot no está configurado');
  // Se limpian los vencidos y se deja un máximo de 10.
  cfg.notices = [...activeNotices(cfg).map((n) => ({ text: n.text, until: n.until, via: n.via, createdAt: n.createdAt })), { text: req.body.text, until, via: 'panel' }].slice(-10);
  await cfg.save();
  void logAudit({ businessId: req.businessId, userId: req.userId, action: 'botconfig.notice', summary: `Agregó el aviso "${req.body.text.slice(0, 60)}".` });
  res.status(201).json({ success: true, data: { notices: activeNotices(cfg) } });
});

/** DELETE /api/botconfig/notices/:id */
export const removeNotice = asyncHandler(async (req, res) => {
  const cfg = await BotConfig.findOneAndUpdate(
    { business: req.businessId },
    { $pull: { notices: { _id: req.params.id } } },
    { new: true }
  );
  res.json({ success: true, data: { notices: activeNotices(cfg) } });
});


/** GET /api/botconfig/audit — última prueba de seguridad del bot. */
export const getBotAudit = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { audit: await lastAudit(req.businessId) } });
});

/** POST /api/botconfig/audit — corre la prueba (7 clientes tramposos, sin efectos). */
export const postBotAudit = asyncHandler(async (req, res) => {
  const audit = await runBotAudit({ businessId: req.businessId, userId: req.userId });
  res.json({ success: true, data: { audit } });
});
