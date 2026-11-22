import { track, isClosing } from '../utils/inflight.js';
import { BotConfig } from '../models/BotConfig.js';
import { Business } from '../models/Business.js';
import { ChatSimulation } from '../models/ChatSimulation.js';
import { logger } from '../utils/logger.js';
import { isGoodHourToNotify, isChannelPaused } from '../utils/botAvailability.js';
import { sendPendingLeadsEmail } from './email.service.js';
import { deliver } from './followUp.service.js';

/**
 * Leads calientes y casos que el bot pasó a una persona, y que NADIE atendió.
 *
 * "Atendido" = alguien del equipo respondió desde la bandeja después de que se
 * marcó el caso, o lo marcó como atendido (se limpia hotLead / needsAttention).
 *
 * 1) Al DUEÑO: un recordatorio por correo si el caso lleva ~2 h sin atender, y un
 *    resumen diario si hay casos de más de un día. Solo en buena hora (abierto
 *    según su horario o, sin horario, de 9 a 20 h).
 * 2) Al CLIENTE (si el negocio no lo apagó: BotConfig.handoffCheckIn): un mensaje fijo (sin IA, sin costo de tokens) si a las ~4 h nadie
 *    le ha escrito: "el equipo ya tiene tu caso", para que no se enfríe. Una vez
 *    por caso, dentro de la ventana de 24 h de Meta, en buena hora y no en modo
 *    manual (si una persona tomó el control, ella decide qué decir).
 *
 * Solo canales reales (no el simulador) y casos de los últimos 3 días; lo más
 * viejo queda en el reporte semanal y en la bandeja.
 */

const HOUR = 60 * 60 * 1000;
const REAL_CHANNELS = ['whatsapp', 'facebook', 'instagram', 'web'];
const CHECKIN_CHANNELS = ['whatsapp', 'facebook', 'instagram'];
export const OWNER_REMINDER_AFTER_MS = 2 * HOUR;
export const CUSTOMER_CHECKIN_AFTER_MS = 4 * HOUR;
const DIGEST_AFTER_MS = 20 * HOUR;
const LOOKBACK_MS = 3 * 24 * HOUR;
const WINDOW_MS = 24 * HOUR;
const WINDOW_MARGIN_MS = 20 * 60 * 1000;
const EMAIL_MAX_ITEMS = 10;

export const CHECKIN_TEXT =
  'Solo para confirmar: el equipo ya tiene este caso y se pondrá en contacto en cuanto pueda. ¡Gracias por la paciencia!';

/** Cuándo empezó el caso abierto (el más antiguo de sus marcas vigentes). */
export function flaggedAt(chat) {
  const times = [];
  if (chat.hotLead && chat.hotLeadAt) times.push(new Date(chat.hotLeadAt).getTime());
  if (chat.needsAttention && chat.attentionAt) times.push(new Date(chat.attentionAt).getTime());
  return times.length ? Math.min(...times) : null;
}

/** ¿Alguien del equipo respondió desde que se marcó el caso? */
export function attendedSince(chat, since) {
  return (chat.messages || []).some(
    (m) => m.role === 'assistant' && m.via === 'agent' && new Date(m.timestamp).getTime() >= since
  );
}

function lastCustomerMessageAt(chat) {
  const msgs = chat.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') return new Date(msgs[i].timestamp).getTime();
  }
  return null;
}

/** Casos abiertos y sin atender de un negocio, con su antigüedad. */
async function pendingCases(businessId, now) {
  const since = new Date(now - LOOKBACK_MS);
  const chats = await ChatSimulation.find({
    business: businessId,
    channel: { $in: REAL_CHANNELS },
    $or: [
      { hotLead: true, hotLeadAt: { $gte: since } },
      { needsAttention: true, attentionAt: { $gte: since } },
    ],
  })
    .select({ messages: { $slice: -40 } })
    .select('channel customerName title hotLead hotLeadAt hotLeadReason needsAttention attentionAt attentionReason handoffMode ownerReminderAt handoffCheckInAt')
    .lean();
  const out = [];
  for (const chat of chats) {
    const start = flaggedAt(chat);
    if (!start || attendedSince(chat, start)) continue;
    out.push({ chat, start, age: now - start });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Recordatorio y resumen al dueño. Devuelve cuántos correos se enviaron (0 o 1). */
async function remindOwner({ business, cases, now }) {
  const due = cases.filter((c) => !c.chat.ownerReminderAt && c.age >= OWNER_REMINDER_AFTER_MS);
  const lastDigest = business.leadDigestAt ? new Date(business.leadDigestAt).getTime() : 0;
  const digestDue = now - lastDigest >= 20 * HOUR && cases.some((c) => c.age >= DIGEST_AFTER_MS);
  if (!due.length && !digestDue) return 0;

  // Reclamo atómico (varias instancias o corridas solapadas no duplican el correo).
  if (digestDue) {
    const claim = await Business.updateOne(
      { _id: business._id, leadDigestAt: business.leadDigestAt ?? null },
      { $set: { leadDigestAt: new Date(now) } },
      { timestamps: false }
    );
    if (!claim.modifiedCount) return 0;
  }
  const listed = digestDue ? cases.filter((c) => c.age >= OWNER_REMINDER_AFTER_MS) : due;
  const ids = listed.map((c) => c.chat._id);
  await ChatSimulation.updateMany({ _id: { $in: ids } }, { $set: { ownerReminderAt: new Date(now) } }, { timestamps: false });

  const items = listed.slice(0, EMAIL_MAX_ITEMS).map(({ chat, age }) => ({
    name: chat.customerName || chat.title || 'Cliente',
    kind: chat.hotLead ? 'lead' : 'attention',
    reason: (chat.hotLead ? chat.hotLeadReason : chat.attentionReason) || '',
    waitingHours: age / HOUR,
  }));
  await sendPendingLeadsEmail({
    userId: business.owner,
    businessName: business.name,
    digest: digestDue,
    items,
    more: Math.max(0, listed.length - EMAIL_MAX_ITEMS),
  });
  return 1;
}

/** Mensaje al cliente de que el equipo ya tiene su caso. Devuelve cuántos se enviaron. */
async function checkInCustomers({ business, cases, now, enabled }) {
  let sent = 0;
  if (!enabled) return 0; // el negocio lo apagó en Entrenamiento
  for (const { chat, age } of cases) {
    if (chat.handoffCheckInAt || age < CUSTOMER_CHECKIN_AFTER_MS) continue;
    if (!CHECKIN_CHANNELS.includes(chat.channel) || chat.handoffMode === 'manual') continue;
    if (isChannelPaused(business, chat.channel, new Date(now))) continue;
    const lastUser = lastCustomerMessageAt(chat);
    if (!lastUser || now - lastUser > WINDOW_MS - WINDOW_MARGIN_MS) continue; // fuera de la ventana de Meta
    if (chat.channel === 'whatsapp' && !business.whatsappPhoneNumberId) continue;
    if (chat.channel === 'facebook' && !business.facebookPageToken) continue;
    if (chat.channel === 'instagram' && !business.instagramPageToken) continue;

    const claim = await ChatSimulation.updateOne(
      { _id: chat._id, handoffCheckInAt: null },
      { $set: { handoffCheckInAt: new Date(now) } },
      { timestamps: false }
    );
    if (!claim.modifiedCount) continue;
    try {
      const full = await ChatSimulation.findById(chat._id).select('channel customerPhone customerId').lean();
      const result = await deliver({ business, chat: full, text: CHECKIN_TEXT });
      if (!result?.ok) {
        logger.warn(`Leads sin atender: no se entregó el aviso al cliente (chat ${chat._id}): ${result?.error || ''}`);
        continue;
      }
      await ChatSimulation.updateOne(
        { _id: chat._id },
        { $push: { messages: { role: 'assistant', content: CHECKIN_TEXT, via: 'bot', followUp: true, timestamp: new Date() } } }
      );
      sent++;
    } catch (err) {
      logger.warn(`Leads sin atender: fallo al avisar al cliente (chat ${chat._id}): ${err.message}`);
    }
  }
  return sent;
}

/** Una pasada por todos los negocios con casos abiertos recientes. */
export async function runLeadFollowUps(now = Date.now()) {
  const since = new Date(now - LOOKBACK_MS);
  const businessIds = await ChatSimulation.distinct('business', {
    channel: { $in: REAL_CHANNELS },
    $or: [
      { hotLead: true, hotLeadAt: { $gte: since } },
      { needsAttention: true, attentionAt: { $gte: since } },
    ],
  });
  let emails = 0;
  let checkIns = 0;
  for (const businessId of businessIds) {
    try {
      const [business, config] = await Promise.all([
        Business.findById(businessId).select('+facebookPageToken +instagramPageToken'),
        BotConfig.findOne({ business: businessId }).select('schedule handoffCheckIn').lean(),
      ]);
      if (!business) continue;
      if (!isGoodHourToNotify(config?.schedule, new Date(now))) continue;
      const cases = await pendingCases(businessId, now);
      if (!cases.length) continue;
      emails += await remindOwner({ business, cases, now });
      checkIns += await checkInCustomers({ business, cases, now, enabled: config?.handoffCheckIn !== false });
    } catch (err) {
      logger.warn(`Leads sin atender: negocio ${businessId}: ${err.message}`);
    }
  }
  if (emails || checkIns) logger.info(`Leads sin atender: ${emails} correo(s) al dueño, ${checkIns} aviso(s) a clientes.`);
  return { emails, checkIns };
}

let running = false;

export function startLeadFollowUpScheduler() {
  if (process.env.LEAD_FOLLOWUP_ENABLED === 'false') {
    logger.info('Leads sin atender: programador desactivado (LEAD_FOLLOWUP_ENABLED=false).');
    return;
  }
  const timer = setInterval(() => {
    if (running || isClosing()) return;
    running = true;
    track(
      runLeadFollowUps()
        .catch((err) => logger.warn(`Leads sin atender: ${err.message}`))
        .finally(() => {
          running = false;
        })
    );
  }, 15 * 60 * 1000);
  timer.unref?.();
  logger.info('Leads sin atender: revisión cada 15 min.');
}
