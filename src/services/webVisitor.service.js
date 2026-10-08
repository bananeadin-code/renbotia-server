import { ChatSimulation } from '../models/ChatSimulation.js';
import { Business } from '../models/Business.js';
import { sendEmail } from './email.service.js';
import { webReplyEmail } from '../emails/webReply.js';
import { logger } from '../utils/logger.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// El visitante "sigue ahí" si el chat sondeó hace menos de esto.
const ONLINE_MS = 90 * 1000;
// Como mucho un correo por conversación en este lapso (varias respuestas
// seguidas del equipo = un solo aviso).
const EMAIL_EVERY_MS = 30 * 60 * 1000;

/**
 * Si el equipo responde en una conversación del chat web y el visitante ya
 * cerró la página, se le avisa por CORREO (solo si dejó un correo en el chat).
 * Fail-open: nunca rompe la respuesta del agente.
 * @returns {Promise<boolean>} true si se envió el aviso.
 */
export async function maybeEmailWebVisitor({ chat, businessId, text }) {
  try {
    if (chat.channel !== 'web' || !EMAIL_RE.test(chat.customerContact || '')) return false;
    const now = Date.now();
    if (chat.webLastSeenAt && now - new Date(chat.webLastSeenAt).getTime() < ONLINE_MS) return false;
    // Reclamo atómico del turno de aviso (anti-spam y anti-duplicado).
    const claim = await ChatSimulation.updateOne(
      {
        _id: chat._id,
        $or: [{ webReplyEmailAt: null }, { webReplyEmailAt: { $lte: new Date(now - EMAIL_EVERY_MS) } }],
      },
      { $set: { webReplyEmailAt: new Date(now) } },
      { timestamps: false }
    );
    if (!claim.modifiedCount) return false;
    const biz = await Business.findById(businessId).select('name').lean();
    const { subject, html } = webReplyEmail({
      businessName: biz?.name,
      customerName: chat.customerName,
      text,
      site: chat.webOrigin,
    });
    const r = await sendEmail({ to: chat.customerContact, subject, html });
    return Boolean(r?.ok);
  } catch (err) {
    logger.warn(`Chat web: no se pudo avisar por correo al visitante: ${err.message}`);
    return false;
  }
}
