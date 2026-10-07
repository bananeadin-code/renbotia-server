import { LearningSuggestion } from '../models/LearningSuggestion.js';
import { logger } from '../utils/logger.js';

/**
 * "Aprende de ti": registra sugerencias de aprendizaje a partir de lo que pasa en
 * las conversaciones (respuestas manuales, malas calificaciones, escalaciones).
 * Lo pendiente aparece en Entrenamiento y en el reporte semanal del lunes. Todo
 * es fail-soft: nunca rompe el flujo del chat si algo falla aquí.
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
