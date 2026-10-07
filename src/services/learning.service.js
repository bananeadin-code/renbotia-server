import { LearningSuggestion } from '../models/LearningSuggestion.js';
import { Business } from '../models/Business.js';
import { logger } from '../utils/logger.js';
import { sendLearningDigestEmail } from './email.service.js';

/**
 * "Aprende de ti": registra sugerencias de aprendizaje a partir de lo que pasa en
 * las conversaciones (respuestas manuales, malas calificaciones, escalaciones) y
 * manda un resumen semanal al dueño. Todo es fail-soft: nunca rompe el flujo del
 * chat si algo falla aquí.
 */

const IMAGE_MARK = '(imagen del cliente)';

export const normalizeQuestion = (q) =>
  String(q || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Último mensaje del cliente antes de la posición `before` (exclusiva). */
export function lastCustomerMessage(chat, before = chat?.messages?.length ?? 0) {
  const msgs = chat?.messages || [];
  for (let i = Math.min(before, msgs.length) - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') {
      const c = (msgs[i].content || '').trim();
      return c && c !== IMAGE_MARK ? c : '';
    }
  }
  return '';
}

/**
 * Crea (o actualiza) una sugerencia pendiente. Si ya hay una pendiente con la
 * misma pregunta, solo completa la respuesta si llega una.
 * @returns {Promise<object|null>} la sugerencia (lean) o null
 */
export async function recordSuggestion({ businessId, chatId = null, source, question, answer = '' }) {
  try {
    const q = String(question || '').trim().slice(0, 500);
    const key = normalizeQuestion(q);
    if (key.length < 4) return null; // "hola", "ok"… no enseñan nada
    const a = String(answer || '').trim().slice(0, 2000);
    const existing = await LearningSuggestion.findOne({ business: businessId, status: 'pending', questionKey: key });
    if (existing) {
      if (a) {
        existing.answer = a;
        existing.source = source === 'agent' ? 'agent' : existing.source;
      }
      existing.chat = chatId || existing.chat;
      await existing.save();
      return existing.toObject();
    }
    const doc = await LearningSuggestion.create({
      business: businessId,
      chat: chatId,
      source,
      question: q,
      questionKey: key,
      answer: a,
    });
    return doc.toObject();
  } catch (err) {
    logger.warn(`Aprendizaje: no se pudo registrar la sugerencia: ${err.message}`);
    return null;
  }
}

/** Quita una sugerencia pendiente (p. ej. si el dueño cambió la mala calificación). */
export async function dropPending({ businessId, question, source }) {
  try {
    await LearningSuggestion.deleteOne({
      business: businessId,
      status: 'pending',
      source,
      questionKey: normalizeQuestion(question),
    });
  } catch {
    /* fail-soft */
  }
}

/* ── Resumen semanal ─────────────────────────────────────────────────────────
   Una vez por semana, si hubo cosas nuevas por enseñar, se avisa al dueño con
   las primeras y un botón a Entrenamiento. La fecha vive en Business. */

const WEEK = 7 * 24 * 60 * 60 * 1000;
let running = false;

export async function runLearningDigest() {
  if (running) return;
  running = true;
  try {
    const since = new Date(Date.now() - WEEK);
    const groups = await LearningSuggestion.aggregate([
      { $match: { status: 'pending', createdAt: { $gte: since } } },
      { $group: { _id: '$business', n: { $sum: 1 } } },
    ]);
    for (const g of groups) {
      const claim = await Business.findOneAndUpdate(
        { _id: g._id, $or: [{ learningDigestAt: null }, { learningDigestAt: { $lt: since } }] },
        { $set: { learningDigestAt: new Date() } },
        { new: true, timestamps: false }
      ).select('name owner');
      if (!claim) continue;
      const items = await LearningSuggestion.find({ business: g._id, status: 'pending' })
        .sort({ createdAt: -1 })
        .limit(5)
        .select('question source')
        .lean();
      const total = await LearningSuggestion.countDocuments({ business: g._id, status: 'pending' });
      void sendLearningDigestEmail({ userId: claim.owner, businessName: claim.name, items, total });
    }
  } catch (err) {
    logger.warn(`Aprendizaje: resumen semanal falló: ${err.message}`);
  } finally {
    running = false;
  }
}

export function startLearningDigestScheduler() {
  const run = () => runLearningDigest();
  setTimeout(run, 5 * 60 * 1000).unref?.();
  setInterval(run, 6 * 60 * 60 * 1000).unref?.();
}
