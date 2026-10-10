import { ManagementConfig } from '../models/ManagementConfig.js';
import { ManagedRecord } from '../models/ManagedRecord.js';
import { Business } from '../models/Business.js';
import { Subscription } from '../models/Subscription.js';
import { ChatSimulation } from '../models/ChatSimulation.js';
import { RECORD_TYPE_META } from '../config/constants.js';
import { logger } from '../utils/logger.js';
import { botAvailability } from '../utils/botAvailability.js';
import { bodyParameters, renderTemplate } from '../utils/waTemplate.js';
import { sendText, sendTemplate, listTemplates } from './whatsapp.service.js';
import { sendMessengerText } from './messenger.service.js';
import { sendInstagramText } from './instagram.service.js';

/**
 * Recordatorios de citas y reservaciones con confirmación (Elite, Gestión).
 *
 * Unas horas antes (24 h por defecto) se le escribe al cliente: "¿Nos confirmas
 * tu cita de mañana a las 4?". Si contesta, el bot marca la cita como
 * confirmada o cancelada (libera el espacio) o, si quiere cambiarla, avisa al
 * equipo. Cómo se envía:
 *  - Dentro de la ventana de 24 h de Meta (el cliente escribió hace poco):
 *    texto libre por WhatsApp, Messenger o Instagram (sin costo de Meta).
 *  - Fuera de la ventana: solo WhatsApp y con una PLANTILLA aprobada (Meta la
 *    cobra al negocio). Sin plantilla, ese recordatorio se omite y queda anotado.
 *  - Citas creadas a mano con un teléfono también reciben recordatorio por
 *    plantilla de WhatsApp.
 * Un solo recordatorio por cita (reclamo atómico), nunca con el canal en pausa,
 * ni para citas agendadas con menos anticipación que el recordatorio.
 */

const HOUR = 60 * 60 * 1000;
const WINDOW_MS = 24 * HOUR;
const WINDOW_MARGIN_MS = 20 * 60 * 1000;
const MIN_AHEAD_MS = 30 * 60 * 1000; // no recordar algo que empieza en minutos
const MAX_PER_RUN = 30;
export const REMINDER_HOURS = [2, 4, 12, 24, 48];
export const REMINDER_PLACEHOLDERS = ['{nombre}', '{fecha}', '{hora}', '{servicio}', '{negocio}'];

const SCHEDULED_TYPES = Object.entries(RECORD_TYPE_META)
  .filter(([, m]) => m.scheduled)
  .map(([k]) => k);

/* ── Lógica pura ───────────────────────────────────────────────────────────── */

/** ¿Toca recordar este registro ahora? */
export function reminderDue(record, hoursBefore, now = Date.now()) {
  if (!SCHEDULED_TYPES.includes(record.type) || !record.scheduledAt) return false;
  if (!['pendiente', 'confirmado'].includes(record.status)) return false;
  if (record.reminder?.status) return false;
  const at = new Date(record.scheduledAt).getTime();
  return at - now > MIN_AHEAD_MS && at - now <= hoursBefore * HOUR;
}

/** ¿Se agendó con menos anticipación que el recordatorio? (no tiene caso recordarla) */
export function bookedTooClose(record, hoursBefore) {
  const created = new Date(record.createdAt || 0).getTime();
  return new Date(record.scheduledAt).getTime() - created < hoursBefore * HOUR;
}

/** Teléfono de WhatsApp a partir de un contacto escrito a mano (MX por defecto). */
export function normalizeWaPhone(contact) {
  const digits = String(contact || '').replace(/\D/g, '');
  if (digits.length === 10) return `52${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return '';
}

export function whenParts(date, tz) {
  const d = new Date(date);
  const fecha = new Intl.DateTimeFormat('es-MX', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(d);
  const hora = new Intl.DateTimeFormat('es-MX', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d).replace(/\s?([ap])\.?\s?m\.?/i, ' $1. m.');
  return { fecha, hora };
}

/** Valores de los marcadores para el texto o la plantilla. */
export function reminderValues(record, businessName, tz) {
  const { fecha, hora } = whenParts(record.scheduledAt, tz);
  return {
    '{nombre}': String(record.customer?.name || '').trim().split(/\s+/)[0] || 'cliente',
    '{fecha}': fecha,
    '{hora}': hora,
    '{servicio}': record.summary || RECORD_TYPE_META[record.type]?.label || 'cita',
    '{negocio}': businessName || '',
  };
}

/** Mensaje libre (dentro de la ventana de 24 h). */
export function reminderText(record, businessName, tz) {
  const v = reminderValues(record, businessName, tz);
  const what = (RECORD_TYPE_META[record.type]?.label || 'cita').toLowerCase();
  const name = v['{nombre}'] !== 'cliente' ? ` ${v['{nombre}']}` : '';
  return `Hola${name}, te recordamos tu ${what}${record.summary ? ` (${record.summary})` : ''} en ${businessName} el ${v['{fecha}']} a las ${v['{hora}']}. ¿Nos confirmas que asistirás? Si necesitas cambiarla, dinos y te ayudamos.`;
}

function lastInboundAt(chat) {
  for (let i = (chat?.messages || []).length - 1; i >= 0; i--) {
    if (chat.messages[i].role === 'user') return new Date(chat.messages[i].timestamp).getTime();
  }
  return null;
}
const windowOpen = (chat, now = Date.now()) => {
  const inbound = lastInboundAt(chat);
  return Boolean(inbound && now < inbound + WINDOW_MS - WINDOW_MARGIN_MS);
};

/* ── Envío ─────────────────────────────────────────────────────────────────── */

let deps = { sendText, sendTemplate, listTemplates, sendMessengerText, sendInstagramText };
export function __setReminderTestHooks(h) {
  deps = { sendText, sendTemplate, listTemplates, sendMessengerText, sendInstagramText, ...(h || {}) };
}

async function mark(record, reminder, extra = {}) {
  await ManagedRecord.updateOne({ _id: record._id }, { $set: { reminder: { ...reminder }, ...extra } });
}

/** Busca o crea la conversación de WhatsApp de un teléfono (citas hechas a mano). */
async function chatForPhone(business, phone, name) {
  const existing = await ChatSimulation.findOne({ business: business._id, channel: 'whatsapp', customerPhone: phone }).sort({ updatedAt: -1 });
  if (existing) return existing;
  return ChatSimulation.create({ business: business._id, channel: 'whatsapp', customerPhone: phone, customerName: name || '', title: name || phone, messages: [] });
}

async function deliverOne({ business, config, settings, record, tz, approved }) {
  const now = Date.now();
  let chat = record.chat ? await ChatSimulation.findOne({ _id: record.chat, business: business._id }) : null;
  if (!chat) {
    const phone = normalizeWaPhone(record.customer?.contact);
    if (!phone || !business.whatsappPhoneNumberId) {
      return mark(record, { status: 'skipped', note: 'Sin conversación ni teléfono de WhatsApp para avisarle.' });
    }
    chat = await chatForPhone(business, phone, record.customer?.name);
  }
  if (!['whatsapp', 'facebook', 'instagram'].includes(chat.channel)) {
    return mark(record, {
      status: 'skipped',
      note: chat.channel === 'web' ? 'Llegó por el chat del sitio: no hay forma de escribirle después.' : 'Registro de prueba del simulador.',
    });
  }
  // Canal en pausa: se reintenta en la siguiente pasada (si aún hay tiempo).
  if (!botAvailability({ business, schedule: null, channel: chat.channel, source: chat.channel }).reply) {
    await ManagedRecord.updateOne({ _id: record._id }, { $set: { reminder: { status: '' } } });
    return;
  }

  let result;
  let content;
  let via;
  if (windowOpen(chat, now)) {
    content = reminderText(record, business.name, tz);
    via = 'text';
    if (chat.channel === 'whatsapp') {
      result = await deps.sendText({ phoneNumberId: business.whatsappPhoneNumberId, to: chat.customerPhone, text: content });
    } else if (chat.channel === 'instagram') {
      result = await deps.sendInstagramText({ pageToken: business.instagramPageToken, recipientId: chat.customerId, text: content });
    } else {
      result = await deps.sendMessengerText({ pageToken: business.facebookPageToken, recipientId: chat.customerId, text: content });
    }
  } else if (chat.channel === 'whatsapp' && approved) {
    const map = reminderValues(record, business.name, tz);
    const values = (settings.template?.params || []).map((p) => String(p || '').replace(/\{(nombre|fecha|hora|servicio|negocio)\}/gi, (m) => map[m.toLowerCase()] ?? ''));
    result = await deps.sendTemplate({
      phoneNumberId: business.whatsappPhoneNumberId,
      to: chat.customerPhone,
      templateName: approved.name,
      languageCode: approved.language,
      bodyParams: bodyParameters(approved.vars, values, approved.named),
    });
    content = renderTemplate(approved.bodyText, approved.vars, values);
    via = 'template';
  } else {
    return mark(record, {
      status: 'skipped',
      note:
        chat.channel === 'whatsapp'
          ? 'Fuera de las 24 h de WhatsApp y sin plantilla de recordatorio elegida.'
          : `Fuera de las 24 h de ${chat.channel === 'instagram' ? 'Instagram' : 'Messenger'}: Meta no permite escribirle.`,
    });
  }

  if (!result?.ok) {
    logger.warn(`Recordatorio: no se entregó (registro ${record._id}): ${result?.error || ''}`);
    return mark(record, { status: 'skipped', note: result?.billing ? 'Meta no tiene método de pago para plantillas.' : 'No se pudo entregar el mensaje.' });
  }
  await ChatSimulation.updateOne(
    { _id: chat._id },
    { $push: { messages: { role: 'assistant', content, via: 'bot', template: via === 'template' ? approved.name : undefined, timestamp: new Date() } } }
  );
  await mark(record, { status: 'sent', sentAt: new Date(), via }, { chat: chat._id, ...(record.channel ? {} : { channel: chat.channel }) });
  return true;
}

async function runForConfig(config) {
  const settings = config.reminders || {};
  const hoursBefore = REMINDER_HOURS.includes(settings.hoursBefore) ? settings.hoursBefore : 24;
  const sub = await Subscription.findOne({ business: config.business }).populate('plan', 'key');
  if ((sub?.plan?.key || 'free') !== 'elite' || !config.enabled) return 0;
  const business = await Business.findById(config.business).select('+facebookPageToken +instagramPageToken');
  if (!business) return 0;
  const now = Date.now();
  const tz = config.timezone || 'America/Mexico_City';

  const candidates = await ManagedRecord.find({
    business: business._id,
    type: { $in: SCHEDULED_TYPES },
    status: { $in: ['pendiente', 'confirmado'] },
    scheduledAt: { $gt: new Date(now + MIN_AHEAD_MS), $lte: new Date(now + hoursBefore * HOUR) },
    'reminder.status': { $in: [null, ''] },
  })
    .sort({ scheduledAt: 1 })
    .limit(MAX_PER_RUN)
    .lean();
  const due = candidates.filter((r) => reminderDue(r, hoursBefore, now));
  if (!due.length) return 0;

  // Plantilla elegida (si existe): debe seguir aprobada y ser enviable.
  let approved = null;
  if (settings.template?.name && business.whatsappWabaId) {
    try {
      const listed = await deps.listTemplates(business.whatsappWabaId);
      approved =
        (listed.templates || []).find(
          (t) => t.name === settings.template.name && (!settings.template.language || t.language === settings.template.language) && t.status === 'APPROVED' && t.usable
        ) || null;
    } catch (err) {
      logger.warn(`Recordatorios: no se pudieron leer plantillas (negocio ${business._id}): ${err.message}`);
    }
  }

  let sent = 0;
  for (const record of due) {
    if (bookedTooClose(record, hoursBefore)) {
      await mark(record, { status: 'skipped', note: 'Se agendó con poca anticipación: no hacía falta recordarla.' });
      continue;
    }
    // Reclamo atómico: un solo recordatorio aunque corran dos instancias.
    const claim = await ManagedRecord.updateOne(
      { _id: record._id, 'reminder.status': { $in: [null, ''] } },
      { $set: { reminder: { status: 'sending' } } }
    );
    if (!claim.modifiedCount) continue;
    try {
      if (await deliverOne({ business, config, settings, record, tz, approved })) sent++;
    } catch (err) {
      logger.warn(`Recordatorio: fallo en registro ${record._id}: ${err.message}`);
      await mark(record, { status: 'skipped', note: 'Error al enviar.' });
    }
  }
  if (sent) logger.info(`Recordatorios: ${sent} enviado(s) para negocio ${business._id}.`);
  return sent;
}

let running = false;
export async function runReminders() {
  if (running) return { skipped: true };
  running = true;
  let total = 0;
  try {
    const configs = await ManagementConfig.find({ enabled: true, 'reminders.enabled': true });
    for (const c of configs) {
      try {
        total += await runForConfig(c);
      } catch (err) {
        logger.warn(`Recordatorios: negocio ${c.business}: ${err.message}`);
      }
    }
    return { sent: total };
  } finally {
    running = false;
  }
}

export function startReminderScheduler() {
  if (process.env.REMINDERS_ENABLED === 'false') {
    logger.info('Recordatorios de citas: programador desactivado (REMINDERS_ENABLED=false).');
    return;
  }
  const timer = setInterval(() => {
    runReminders().catch((err) => logger.warn(`Recordatorios: ${err.message}`));
  }, 10 * 60 * 1000);
  timer.unref?.();
  logger.info('Recordatorios de citas: revisión cada 10 min.');
}

/* ── Respuesta del cliente (herramienta del bot) ──────────────────────────── */

/** Cita con recordatorio enviado y sin respuesta en esta conversación. */
export async function pendingReminderFor(businessId, chatId) {
  if (!chatId) return null;
  return ManagedRecord.findOne({
    business: businessId,
    chat: chatId,
    'reminder.status': 'sent',
    scheduledAt: { $gt: new Date() },
  })
    .sort({ scheduledAt: 1 })
    .lean();
}

export function buildReminderTool() {
  return {
    name: 'responder_recordatorio',
    description:
      'El cliente responde al recordatorio de su cita: "confirma" si asistirá, "cancela" si ya no irá, "cambiar" si quiere otra fecha u hora. Úsala solo si su mensaje responde al recordatorio.',
    input_schema: {
      type: 'object',
      properties: {
        respuesta: { type: 'string', enum: ['confirma', 'cancela', 'cambiar'] },
        comentario: { type: 'string', description: 'Lo que dijo el cliente, breve (opcional).' },
      },
      required: ['respuesta'],
    },
  };
}

/** Nota para el bot sobre el recordatorio pendiente de esta conversación. */
export function reminderNote(record, tz) {
  const { fecha, hora } = whenParts(record.scheduledAt, tz);
  const what = (RECORD_TYPE_META[record.type]?.label || 'cita').toLowerCase();
  return `\n\n# RECORDATORIO PENDIENTE\nLe enviaste al cliente un recordatorio de su ${what}${record.summary ? ` (${record.summary})` : ''} del ${fecha} a las ${hora}. Si su mensaje confirma que asistirá, llama responder_recordatorio con "confirma"; si cancela, con "cancela"; si quiere cambiar la fecha u hora, con "cambiar". Si escribe de otra cosa, atiéndelo con normalidad.`;
}

/** Aplica la respuesta del cliente a la cita. Devuelve el resultado para el bot. */
export async function answerReminder(record, respuesta, comentario = '') {
  const now = new Date();
  const note = String(comentario || '').slice(0, 200);
  if (respuesta === 'confirma') {
    await ManagedRecord.updateOne({ _id: record._id }, { $set: { status: 'confirmado', 'reminder.status': 'confirmed', 'reminder.answeredAt': now, 'reminder.note': note } });
    return { result: { ok: true, mensaje: 'Cita confirmada. Agradécele y dile que lo esperan.' } };
  }
  if (respuesta === 'cancela') {
    await ManagedRecord.updateOne({ _id: record._id }, { $set: { status: 'cancelado', 'reminder.status': 'cancelled', 'reminder.answeredAt': now, 'reminder.note': note } });
    return { result: { ok: true, mensaje: 'Cita cancelada y el espacio quedó libre. Responde con amabilidad y ofrece agendar otra vez cuando guste.' } };
  }
  if (respuesta === 'cambiar') {
    await ManagedRecord.updateOne({ _id: record._id }, { $set: { 'reminder.status': 'reschedule', 'reminder.answeredAt': now, 'reminder.note': note } });
    return {
      result: { ok: true, mensaje: 'Se avisó al equipo que quiere cambiar su cita. Dile que en breve le ayudan a elegir otro horario.' },
      escalate: `Quiere cambiar su ${(RECORD_TYPE_META[record.type]?.label || 'cita').toLowerCase()}${note ? `: "${note}"` : ''}`,
    };
  }
  return { result: { ok: false, error: 'Respuesta no válida.' } };
}
