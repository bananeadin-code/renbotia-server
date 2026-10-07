import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { LearningSuggestion } from '../models/LearningSuggestion.js';
import { BotConfig } from '../models/BotConfig.js';
import { Subscription } from '../models/Subscription.js';
import { getPlanLimits } from '../utils/planGating.js';
import { validateTrainingConfig } from '../services/validation.service.js';
import { logAudit } from '../services/audit.service.js';

/**
 * "Aprende de ti": lista lo pendiente por enseñar y lo convierte en pregunta
 * frecuente del bot (respetando el límite de FAQs del plan) o lo descarta.
 */

/** GET /api/learning — sugerencias pendientes (más recientes primero). */
export const listSuggestions = asyncHandler(async (req, res) => {
  const items = await LearningSuggestion.find({ business: req.businessId, status: 'pending' })
    .sort({ updatedAt: -1 })
    .limit(30)
    .select('question answer source chat createdAt')
    .lean();
  const total = await LearningSuggestion.countDocuments({ business: req.businessId, status: 'pending' });
  res.json({
    success: true,
    data: {
      total,
      items: items.map((s) => ({
        id: s._id,
        question: s.question,
        answer: s.answer,
        source: s.source,
        chatId: s.chat,
        createdAt: s.createdAt,
      })),
    },
  });
});

export const acceptSchema = z.object({
  question: z.string().trim().min(2, 'La pregunta es muy corta').max(500),
  answer: z.string().trim().min(2, 'Escribe la respuesta que debe dar el bot').max(2000),
});

/** POST /api/learning/:id/accept — la convierte en pregunta frecuente. */
export const acceptSuggestion = asyncHandler(async (req, res) => {
  const s = await LearningSuggestion.findOne({ _id: req.params.id, business: req.businessId, status: 'pending' });
  if (!s) throw ApiError.notFound('Esa sugerencia ya no está pendiente.');

  const sub = await Subscription.findOne({ business: req.businessId }).populate('plan', 'key');
  const limits = getPlanLimits(sub?.plan?.key || 'free');
  const config = await BotConfig.findOne({ business: req.businessId });
  if (!config) throw ApiError.notFound('El bot no está configurado');
  if (limits.maxFaqs != null && config.faqs.length >= limits.maxFaqs) {
    throw new ApiError(
      403,
      `Tu plan permite ${limits.maxFaqs} preguntas frecuentes y ya las usaste. Edita una existente en Entrenamiento o mejora tu plan.`,
      { code: 'FAQ_LIMIT' }
    );
  }

  const faq = { question: req.body.question, answer: req.body.answer };
  // Misma validación que al guardar el entrenamiento (anti-abuso / inyección).
  const issues = await validateTrainingConfig({ faqs: [faq] });
  if (issues.length) {
    throw new ApiError(422, issues[0]?.reason || 'Ese contenido no sirve como pregunta frecuente.', {
      code: 'CONTENT_REJECTED',
      issues,
    });
  }

  config.faqs.push(faq);
  await config.save();
  s.status = 'accepted';
  s.answer = faq.answer;
  await s.save();

  void logAudit({
    businessId: req.businessId,
    userId: req.userId,
    action: 'learning.accept',
    summary: `Enseñó al bot: "${faq.question.slice(0, 80)}".`,
  });
  const added = config.faqs[config.faqs.length - 1];
  res.json({ success: true, data: { faq: { _id: added._id, question: added.question, answer: added.answer } } });
});

/** POST /api/learning/:id/dismiss — la descarta. */
export const dismissSuggestion = asyncHandler(async (req, res) => {
  const r = await LearningSuggestion.updateOne(
    { _id: req.params.id, business: req.businessId, status: 'pending' },
    { $set: { status: 'dismissed' } }
  );
  if (!r.matchedCount) throw ApiError.notFound('Esa sugerencia ya no está pendiente.');
  res.json({ success: true, data: { dismissed: true } });
});
