import crypto from 'node:crypto';
import { Business } from '../models/Business.js';
import { BotConfig } from '../models/BotConfig.js';
import { Subscription } from '../models/Subscription.js';
import { ChatSimulation } from '../models/ChatSimulation.js';
import { LearningSuggestion } from '../models/LearningSuggestion.js';
import { UsageLog } from '../models/UsageLog.js';
import { User } from '../models/User.js';
import { ManagedRecord } from '../models/ManagedRecord.js';
import { OwnerMessage } from '../models/OwnerMessage.js';
import '../models/Plan.js';
import { MODEL_BY_PLAN, RECORD_TYPE_META } from '../config/constants.js';
import { getPlanLimits } from '../utils/planGating.js';
import { isChannelPaused, isOpenNow } from '../utils/botAvailability.js';
import { generateReplyWithTools } from './claude.service.js';
import { applyLazyReset, hasBalance, deductTokens, computeBalance } from './token.service.js';
import { computeImpact } from './impact.service.js';
import { validateTrainingConfig } from './validation.service.js';
import { sendText } from './whatsapp.service.js';
import { sendEmail } from './email.service.js';
import { logAudit } from './audit.service.js';
import { logger } from '../utils/logger.js';

/**
 * Control del bot desde el WhatsApp del DUEÑO.
 *
 * Seguridad:
 *  - Vincular exige un código de un solo uso (8 caracteres, 10 min) generado en el
 *    panel con sesión del dueño y ENVIADO DESDE el número a vincular: el webhook
 *    llega firmado por Meta (HMAC) y Meta pone el número de quien escribe, así que
 *    no se puede suplantar. Se guarda solo el hash del código.
 *  - Máx. 2 números, 5 intentos fallidos por hora, aviso por correo al vincular.
 *  - Vence a los 30 días sin uso; restablecer la contraseña desvincula todo.
 *  - El asistente solo tiene herramientas acotadas (estado, resumen, leads,
 *    pendientes, buscar clientes, agenda, pausar/reanudar, avisos, preguntas).
 *    Nada de facturación, planes, borrar datos, desconectar canales ni escribir
 *    a clientes. Lo que llega a los clientes (pausa, avisos, preguntas) pide
 *    confirmación; lo reversible (reactivar, quitar aviso, estado de la agenda)
 *    se aplica al momento. Todo queda en la bitácora.
 *  - Recuerda la charla reciente (OwnerMessage, 3 días) para entender respuestas
 *    cortas como "en todos" o "sí, hazlo".
 *  - Los mensajes del dueño nunca se mezclan con las conversaciones de clientes.
 */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /^\s*RB-([A-Z0-9]{8})\s*$/i;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_NUMBERS = 2;
const MAX_FAILURES = 5;
const INACTIVE_MS = 30 * 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 15 * 60 * 1000;
// Modelo del asistente del dueño: el más confiable por defecto; se puede cambiar
// en Render (OWNER_ASSISTANT_MODEL) si el costo lo pide, sin tocar código.
const OWNER_MODEL = process.env.OWNER_ASSISTANT_MODEL || MODEL_BY_PLAN.elite;
const DAILY_CAP = 60;
const CUSTOMER_MODE_MS = 30 * 60 * 1000;

const sha = (s) => crypto.createHash('sha256').update(String(s).toUpperCase()).digest('hex');
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
export const maskWaId = (waId) => {
  const d = String(waId || '');
  return d.length > 6 ? `+${d.slice(0, 2)} •••• ${d.slice(-4)}` : '••••';
};

/* ── Vinculación ───────────────────────────────────────────────────────────── */

export function isLinkCode(text) {
  return CODE_RE.test(String(text || ''));
}

/** Nuevo código de un solo uso (reemplaza al anterior). */
export async function createLinkCode(businessId) {
  const bytes = crypto.randomBytes(8);
  const raw = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  const code = `RB-${raw}`;
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  await Business.updateOne({ _id: businessId }, { $set: { 'ownerLinkCode.hash': sha(raw), 'ownerLinkCode.expiresAt': expiresAt } });
  return { code, expiresAt };
}

async function reply(business, phoneNumberId, to, text) {
  return deps.send({ phoneNumberId: phoneNumberId || business.whatsappPhoneNumberId, to, text });
}

/** Mensaje "RB-XXXXXXXX": intenta vincular ese número como dueño. */
export async function tryLinkOwner({ business: base, waId, text, phoneNumberId }) {
  const business = await Business.findById(base._id).select('+ownerLinkCode.hash');
  if (!business) return;
  const now = Date.now();

  // Tope de intentos fallidos por hora (contra fuerza bruta de códigos).
  const f = business.ownerLinkFailures || {};
  const windowOpen = f.windowStart && now - new Date(f.windowStart).getTime() < 60 * 60 * 1000;
  if (windowOpen && f.count >= MAX_FAILURES) {
    await reply(business, phoneNumberId, waId, 'Demasiados intentos. Genera un código nuevo en tu panel dentro de una hora.');
    return;
  }

  const raw = CODE_RE.exec(text)[1].toUpperCase();
  const stored = business.ownerLinkCode?.hash || '';
  const valid =
    stored &&
    business.ownerLinkCode?.expiresAt &&
    new Date(business.ownerLinkCode.expiresAt).getTime() > now &&
    crypto.timingSafeEqual(Buffer.from(sha(raw)), Buffer.from(stored));

  if (!valid) {
    business.ownerLinkFailures = windowOpen ? { count: (f.count || 0) + 1, windowStart: f.windowStart } : { count: 1, windowStart: new Date() };
    await business.save();
    await reply(business, phoneNumberId, waId, 'Ese código no es válido o ya venció. Genera uno nuevo en tu panel: Conexiones → WhatsApp.');
    return;
  }

  // Código usado: se borra siempre (un solo uso).
  business.ownerLinkCode = { hash: '', expiresAt: null };
  business.ownerLinkFailures = { count: 0, windowStart: null };
  const already = business.ownerWhatsApp.some((o) => o.waId === waId);
  if (!already && business.ownerWhatsApp.length >= MAX_NUMBERS) {
    await business.save();
    await reply(business, phoneNumberId, waId, `Ya hay ${MAX_NUMBERS} números vinculados. Quita uno en tu panel (Conexiones → WhatsApp) y vuelve a intentar.`);
    return;
  }
  if (!already) business.ownerWhatsApp.push({ waId, linkedAt: new Date(), lastUsedAt: new Date() });
  await business.save();

  void logAudit({
    businessId: business._id,
    userId: business.owner,
    action: 'owner.whatsapp.link',
    summary: `Vinculó el WhatsApp ${maskWaId(waId)} para manejar el bot.`,
  });
  const owner = await User.findById(business.owner).select('email name').lean();
  if (owner?.email) {
    void sendEmail({
      to: owner.email,
      subject: 'Se vinculó un número a tu bot de RenBotIA',
      html: `<p>Hola${owner.name ? ` ${owner.name.split(' ')[0]}` : ''},</p>
        <p>El número <b>${maskWaId(waId)}</b> ahora puede manejar el bot de <b>${business.name}</b> por WhatsApp (resumen, leads, pausar el bot, avisos y preguntas).</p>
        <p>Si no fuiste tú, entra a tu panel → Conexiones → WhatsApp, quita ese número y cambia tu contraseña.</p>`,
    });
  }
  await reply(
    business,
    phoneNumberId,
    waId,
    `*¡Listo!* Soy tu asistente para manejar el bot de ${business.name}. Escríbeme como le escribirías a alguien de tu equipo, por ejemplo:\n• ¿Cómo vamos hoy?\n• ¿Qué quería Laura?\n• ¿Qué tengo en la agenda mañana?\n• Pausa el bot hasta las 6\n• Hoy cerramos a las 4\n\nPara probar tu bot como cliente escribe *modo cliente*.`
  );
}

/** ¿Este número es del dueño (vinculado y vigente)? */
export function ownerEntry(business, waId) {
  return (business.ownerWhatsApp || []).find((o) => o.waId === waId) || null;
}

/* ── Utilidades de hora local ──────────────────────────────────────────────── */

const CHANNELS = { whatsapp: 'WhatsApp', messenger: 'Messenger', instagram: 'Instagram', sitio_web: 'el chat del sitio web' };
const KEY_OF = { whatsapp: 'whatsapp', messenger: 'facebook', instagram: 'instagram', sitio_web: 'web' };
const ALL_LABEL = 'todos tus canales (WhatsApp, Messenger, Instagram y el chat del sitio)';
const CHANNEL_NAME = { whatsapp: 'WhatsApp', facebook: 'Messenger', instagram: 'Instagram', web: 'Sitio web' };
const STATUS_LABEL = { pendiente: 'pendiente', confirmado: 'confirmado', completado: 'completado', cancelado: 'cancelado' };

/** Partes de la hora local del negocio. */
function localParts(tz, date = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const v = (t) => Number(p.find((x) => x.type === t).value);
  return { day: v('day'), h: v('hour'), m: v('minute') };
}
/** Próxima vez que el reloj local marque HH:MM (hoy o mañana). */
function nextLocalTime(tz, hhmm) {
  const m = /^(\d{1,2}):?(\d{2})?$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const target = Number(m[1]) * 60 + Number(m[2] || 0);
  if (target >= 24 * 60) return null;
  const { h, m: mi } = localParts(tz);
  let diff = target - (h * 60 + mi);
  if (diff <= 0) diff += 24 * 60;
  return new Date(Date.now() + diff * 60 * 1000);
}
/** Inicio del día local (+N días). */
function startOfLocalDay(tz, plusDays = 0) {
  const { h, m } = localParts(tz);
  return new Date(Date.now() - (h * 60 + m) * 60000 + plusDays * 864e5);
}
const endOfLocalDay = (tz, extraDays = 0) => new Date(startOfLocalDay(tz, extraDays + 1).getTime() - 60000);
const fmtLocal = (tz, d) =>
  new Intl.DateTimeFormat('es-MX', { timeZone: tz, weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    .format(d)
    .replace(/\.$/, ''); // "p.m." sin el punto final, para no duplicarlo en las frases
const money = (n) => `$${Math.round(n || 0).toLocaleString('es-MX')}`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ── Herramientas del asistente ────────────────────────────────────────────── */

const CANAL = { type: 'string', enum: ['whatsapp', 'messenger', 'instagram', 'sitio_web', 'todos'] };
const TOOLS = [
  {
    name: 'ver_estado',
    description:
      'Estado actual del bot: si está activo o en pausa en cada canal (y hasta cuándo), qué canales están conectados, si el negocio está abierto según su horario, conversaciones disponibles y avisos vigentes. Úsala ante cualquier duda sobre si el bot está funcionando.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'ver_resumen',
    description: 'Resultados del bot (conversaciones, leads, citas/pedidos, valor estimado, fuera de horario).',
    input_schema: { type: 'object', properties: { periodo: { type: 'string', enum: ['hoy', 'semana', 'mes'] } }, required: ['periodo'] },
  },
  {
    name: 'ver_leads',
    description: 'Leads calientes abiertos (clientes con alta intención de compra) para darles seguimiento.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'ver_pendientes',
    description: 'Conversaciones que esperan a una persona y preguntas que el bot aún no sabe responder.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'buscar_cliente',
    description:
      'Busca conversaciones de clientes por nombre, teléfono o palabra (ej. "Laura", "pastel de 3 leches") y devuelve lo último que se habló, el canal y si espera respuesta.',
    input_schema: { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'] },
  },
  {
    name: 'ver_agenda',
    description:
      'Citas, reservaciones, pedidos y prospectos del módulo de Gestión. "pendientes" = lo que falta confirmar. Cada registro trae un id para cambiar su estado.',
    input_schema: {
      type: 'object',
      properties: { periodo: { type: 'string', enum: ['hoy', 'manana', 'semana', 'pendientes'] } },
      required: ['periodo'],
    },
  },
  {
    name: 'cambiar_estado_registro',
    description: 'Cambia el estado de un registro de la agenda usando el id de ver_agenda. Se aplica de inmediato.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' }, estado: { type: 'string', enum: ['pendiente', 'confirmado', 'completado', 'cancelado'] } },
      required: ['id', 'estado'],
    },
  },
  {
    name: 'pausar_bot',
    description:
      'Pausa al bot (los mensajes llegan a la bandeja y los contesta una persona). "todos" = WhatsApp, Messenger, Instagram y el chat del sitio web. Queda pendiente de que el dueño confirme.',
    input_schema: {
      type: 'object',
      properties: {
        canal: CANAL,
        hasta: { type: 'string', description: 'Hora local en formato 24 h HH:MM en que se reactiva solo (ej. 18:00). Opcional.' },
        minutos: { type: 'number', description: 'O cuántos minutos dura la pausa. Opcional.' },
      },
      required: ['canal'],
    },
  },
  {
    name: 'reanudar_bot',
    description: 'Reactiva al bot en un canal o en todos. Se aplica de inmediato.',
    input_schema: { type: 'object', properties: { canal: CANAL }, required: ['canal'] },
  },
  {
    name: 'agregar_aviso',
    description:
      'Aviso temporal que el bot comunicará a los clientes (ej. "hoy cerramos a las 4", "ya no hay pastel de chocolate"). Queda pendiente de que el dueño confirme.',
    input_schema: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'El aviso, breve y claro, como dato del negocio.' },
        vigencia: { type: 'string', enum: ['hoy', 'manana', 'semana', 'indefinido'] },
      },
      required: ['texto', 'vigencia'],
    },
  },
  { name: 'ver_avisos', description: 'Avisos temporales vigentes (numerados).', input_schema: { type: 'object', properties: {} } },
  {
    name: 'quitar_aviso',
    description: 'Quita un aviso vigente por su número (de ver_avisos). Se aplica de inmediato.',
    input_schema: { type: 'object', properties: { numero: { type: 'number' } }, required: ['numero'] },
  },
  {
    name: 'agregar_pregunta',
    description: 'Agrega una pregunta frecuente con su respuesta al entrenamiento del bot. Queda pendiente de que el dueño confirme.',
    input_schema: {
      type: 'object',
      properties: { pregunta: { type: 'string' }, respuesta: { type: 'string' } },
      required: ['pregunta', 'respuesta'],
    },
  },
  {
    name: 'confirmar_accion',
    description:
      'Ejecuta la acción pendiente. Úsala SOLO si en su ÚLTIMO mensaje el dueño acepta claramente (ej. "sí, hazlo", "adelante", "confírmalo", "va").',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'cancelar_accion',
    description: 'Descarta la acción pendiente si el dueño dice que no, que mejor no o que era una prueba.',
    input_schema: { type: 'object', properties: {} },
  },
];

const NEEDS_CONFIRM = new Set(['pausar_bot', 'agregar_aviso', 'agregar_pregunta']);
const IMMEDIATE = new Set(['reanudar_bot', 'quitar_aviso', 'cambiar_estado_registro', 'confirmar_accion', 'cancelar_accion']);

function audit(ctx, action, summary) {
  void logAudit({
    businessId: ctx.business._id,
    userId: ctx.business.owner,
    action: `owner.whatsapp.${action}`,
    summary: `Desde WhatsApp (${maskWaId(ctx.waId)}): ${summary}.`,
  });
}

/** Estado de pausa de cada canal, en palabras. */
function pauseState(business, tz) {
  return Object.entries(KEY_OF).map(([canal, key]) => {
    const paused = isChannelPaused(business, key);
    const until = business.channelSettings?.[key]?.pausedUntil;
    return {
      canal: CHANNELS[canal],
      bot: paused ? (until ? `en pausa hasta ${fmtLocal(tz, new Date(until))}` : 'en pausa hasta que lo reactives') : 'activo',
    };
  });
}

async function runReadTool(name, input, ctx) {
  const { business, tz } = ctx;
  if (name === 'ver_estado') {
    const [b, cfg] = await Promise.all([
      Business.findById(business._id).select('channelSettings whatsappPhoneNumberId facebookPageId instagramAccountId widget.enabled').lean(),
      BotConfig.findOne({ business: business._id }).select('schedule notices').lean(),
    ]);
    const connected = {
      WhatsApp: Boolean(b.whatsappPhoneNumberId),
      Messenger: Boolean(b.facebookPageId),
      Instagram: Boolean(b.instagramAccountId),
      [CHANNELS.sitio_web]: Boolean(b.widget?.enabled),
    };
    const open = isOpenNow(cfg?.schedule);
    const now = Date.now();
    const bal = computeBalance(ctx.sub);
    return {
      canales: pauseState(b, tz).map((c) => ({ ...c, conectado: connected[c.canal] })),
      horario: open === null ? 'sin horario configurado (el bot contesta siempre)' : open ? 'abierto ahora' : 'cerrado ahora',
      modo_horario:
        cfg?.schedule?.enabled && cfg.schedule.botMode === 'closed_only' ? 'el bot solo contesta fuera de horario' : 'el bot contesta siempre',
      conversaciones_disponibles_aprox: Math.round(bal.available / 5000),
      avisos_vigentes: (cfg?.notices || []).filter((n) => !n.until || new Date(n.until).getTime() > now).length,
    };
  }
  if (name === 'ver_resumen') {
    const now = new Date();
    const { day, h, m } = localParts(tz);
    const since =
      input.periodo === 'hoy'
        ? startOfLocalDay(tz)
        : input.periodo === 'semana'
          ? new Date(now.getTime() - 7 * 864e5)
          : new Date(now.getTime() - ((day - 1) * 24 * 60 + h * 60 + m) * 60000);
    const i = await computeImpact(business._id, since, now);
    return {
      periodo: input.periodo,
      conversaciones: i.conversations,
      respuestas_del_bot: i.botReplies,
      leads_calientes: i.hotLeads,
      citas_y_pedidos: i.captured,
      fuera_de_horario: i.outsideHours,
      valor_estimado: i.settings.configured ? money(i.value.total) : 'sin ticket promedio configurado',
    };
  }
  if (name === 'ver_leads') {
    const leads = await ChatSimulation.find({ business: business._id, hotLead: true, channel: { $ne: 'simulator' } })
      .sort({ hotLeadAt: -1 })
      .limit(5)
      .select('customerName title hotLeadReason channel hotLeadAt')
      .lean();
    return {
      leads: leads.map((l) => ({
        nombre: l.customerName || l.title || 'Cliente',
        motivo: l.hotLeadReason || '',
        canal: CHANNEL_NAME[l.channel] || l.channel,
        cuando: l.hotLeadAt ? fmtLocal(tz, new Date(l.hotLeadAt)) : '',
      })),
    };
  }
  if (name === 'ver_pendientes') {
    const [attention, learning] = await Promise.all([
      ChatSimulation.find({ business: business._id, needsAttention: true, channel: { $ne: 'simulator' } })
        .sort({ updatedAt: -1 })
        .limit(5)
        .select('customerName title channel attentionReason')
        .lean(),
      LearningSuggestion.find({ business: business._id, status: 'pending' }).sort({ updatedAt: -1 }).limit(5).select('question').lean(),
    ]);
    return {
      esperan_a_una_persona: attention.map((c) => ({
        cliente: c.customerName || c.title || 'Cliente',
        canal: CHANNEL_NAME[c.channel] || c.channel,
        motivo: c.attentionReason || '',
      })),
      el_bot_no_sabe: learning.map((s) => s.question),
    };
  }
  if (name === 'buscar_cliente') {
    const q = String(input.texto || '').trim().slice(0, 60);
    if (q.length < 2) return { error: 'Dime un nombre, teléfono o palabra para buscar.' };
    const rx = new RegExp(escapeRe(q), 'i');
    const chats = await ChatSimulation.find(
      {
        business: business._id,
        channel: { $ne: 'simulator' },
        $or: [{ customerName: rx }, { title: rx }, { customerPhone: rx }, { customerContact: rx }, { 'messages.content': rx }],
      },
      { customerName: 1, title: 1, channel: 1, needsAttention: 1, hotLead: 1, handoffMode: 1, updatedAt: 1, messages: { $slice: -6 } }
    )
      .sort({ updatedAt: -1 })
      .limit(3)
      .lean();
    if (!chats.length) return { resultados: [], nota: `No encontré conversaciones con "${q}".` };
    return {
      resultados: chats.map((c) => ({
        cliente: c.customerName || c.title || 'Cliente',
        canal: CHANNEL_NAME[c.channel] || c.channel,
        ultima_actividad: fmtLocal(tz, new Date(c.updatedAt)),
        espera_respuesta: Boolean(c.needsAttention),
        lead_caliente: Boolean(c.hotLead),
        atiende: c.handoffMode === 'manual' ? 'una persona' : 'el bot',
        ultimos_mensajes: (c.messages || []).map((m) => `${m.role === 'user' ? 'Cliente' : m.via === 'agent' ? 'Tu equipo' : 'Bot'}: ${String(m.content).slice(0, 220)}`),
      })),
    };
  }
  if (name === 'ver_agenda') {
    if ((ctx.sub?.plan?.key || 'free') !== 'elite') return { nota: 'La agenda (módulo de Gestión) es parte del plan Elite.' };
    const base = { business: business._id };
    let query;
    if (input.periodo === 'pendientes') query = { ...base, status: 'pendiente' };
    else {
      const from = input.periodo === 'manana' ? startOfLocalDay(tz, 1) : input.periodo === 'hoy' ? startOfLocalDay(tz) : new Date();
      const to = input.periodo === 'semana' ? new Date(Date.now() + 7 * 864e5) : new Date(from.getTime() + 864e5);
      query = { ...base, scheduledAt: { $gte: from, $lt: to }, status: { $in: ['pendiente', 'confirmado'] } };
    }
    const recs = await ManagedRecord.find(query)
      .sort(input.periodo === 'pendientes' ? { createdAt: -1 } : { scheduledAt: 1 })
      .limit(10)
      .lean();
    return {
      registros: recs.map((r) => ({
        id: String(r._id),
        tipo: RECORD_TYPE_META[r.type]?.label || r.type,
        resumen: r.summary || '',
        cliente: r.customer?.name || '',
        contacto: r.customer?.contact || '',
        cuando: r.scheduledAt ? fmtLocal(tz, new Date(r.scheduledAt)) : '',
        estado: r.status,
        canal: CHANNEL_NAME[r.channel] || (r.source === 'manual' ? 'creado a mano' : ''),
        recordatorio:
          { sent: 'enviado, sin respuesta', confirmed: 'el cliente confirmó', cancelled: 'el cliente canceló', reschedule: 'quiere cambiarla', skipped: 'no se envió' }[
            r.reminder?.status
          ] || '',
      })),
    };
  }
  if (name === 'ver_avisos') {
    const cfg = await BotConfig.findOne({ business: business._id }).select('notices').lean();
    const now = Date.now();
    const list = (cfg?.notices || []).filter((n) => !n.until || new Date(n.until).getTime() > now);
    return {
      avisos: list.map((n, i) => ({ numero: i + 1, texto: n.text, vence: n.until ? fmtLocal(tz, new Date(n.until)) : 'sin fecha' })),
    };
  }
  return { error: 'herramienta desconocida' };
}

/** Prepara una acción que queda pendiente del "sí" del dueño. */
async function prepareAction(name, input, ctx) {
  const { business, tz } = ctx;
  let summary = '';
  let args = { ...input };
  if (name === 'pausar_bot') {
    const canal = input.canal || 'todos';
    const label = canal === 'todos' ? ALL_LABEL : CHANNELS[canal];
    const until = input.hasta
      ? nextLocalTime(tz, input.hasta)
      : input.minutos
        ? new Date(Date.now() + Math.min(Math.max(Number(input.minutos), 5), 7 * 24 * 60) * 60000)
        : null;
    if (input.hasta && !until) return { ok: false, error: 'Hora no válida. Usa formato 24 h HH:MM (ej. 18:00).' };
    args = { canal, until: until ? until.toISOString() : null };
    summary = `Pausar el bot en ${label}${until ? ` hasta ${fmtLocal(tz, until)}` : ' hasta que lo reactives'}`;
  } else if (name === 'agregar_aviso') {
    const texto = String(input.texto || '').trim().slice(0, 200);
    if (texto.length < 3) return { ok: false, error: 'El aviso está vacío.' };
    const until =
      input.vigencia === 'hoy' ? endOfLocalDay(tz) : input.vigencia === 'manana' ? endOfLocalDay(tz, 1) : input.vigencia === 'semana' ? new Date(Date.now() + 7 * 864e5) : null;
    args = { texto, until: until ? until.toISOString() : null };
    summary = `Agregar el aviso "${texto}"${until ? ` (vence ${fmtLocal(tz, until)})` : ' (sin fecha de vencimiento)'}`;
  } else if (name === 'agregar_pregunta') {
    const pregunta = String(input.pregunta || '').trim().slice(0, 300);
    const respuesta = String(input.respuesta || '').trim().slice(0, 800);
    if (pregunta.length < 3 || respuesta.length < 2) return { ok: false, error: 'Falta la pregunta o la respuesta.' };
    args = { pregunta, respuesta };
    summary = `Agregar la pregunta frecuente "${pregunta}" con la respuesta "${respuesta}"`;
  }
  await Business.updateOne(
    { _id: business._id },
    { $set: { ownerPending: { action: name, args, summary, waId: ctx.waId, expiresAt: new Date(Date.now() + PENDING_TTL_MS) } } }
  );
  ctx.pendingSummary = summary;
  return { ok: true, pendiente_de_confirmacion: summary, instruccion: 'Explica en una línea y pide que responda SÍ.' };
}

/** Cambia el estado de pausa de uno o todos los canales. */
async function setPause(business, canal, paused, until = null) {
  const keys = canal === 'todos' ? Object.values(KEY_OF) : [KEY_OF[canal]].filter(Boolean);
  const set = {};
  for (const k of keys) {
    set[`channelSettings.${k}.paused`] = paused;
    set[`channelSettings.${k}.pausedUntil`] = paused && until ? new Date(until) : null;
  }
  await Business.updateOne({ _id: business._id }, { $set: set });
}

/** Ejecuta una acción confirmada. Devuelve el texto para el dueño. */
async function executePending(business, pending, tz) {
  const { action, args } = pending;
  if (action === 'pausar_bot') {
    await setPause(business, args.canal, true, args.until);
    const where = args.canal === 'todos' ? ALL_LABEL : CHANNELS[args.canal];
    return `Listo, el bot quedó en pausa en ${where}${args.until ? ` hasta ${fmtLocal(tz, new Date(args.until))}` : ''}. Los mensajes llegan a tu bandeja. Cuando quieras, dime "reactiva el bot".`;
  }
  if (action === 'agregar_aviso') {
    await BotConfig.updateOne(
      { business: business._id },
      { $push: { notices: { $each: [{ text: args.texto, until: args.until ? new Date(args.until) : null, via: 'whatsapp' }], $slice: -10 } } }
    );
    return 'Listo, el bot ya lo sabe y lo dirá a tus clientes cuando aplique.';
  }
  if (action === 'agregar_pregunta') {
    const sub = await Subscription.findOne({ business: business._id }).populate('plan', 'key');
    const limits = getPlanLimits(sub?.plan?.key || 'free');
    const cfg = await BotConfig.findOne({ business: business._id });
    if (limits.maxFaqs != null && cfg.faqs.length >= limits.maxFaqs) {
      return `Tu plan permite ${limits.maxFaqs} preguntas frecuentes y ya las usaste. Puedes editarlas o mejorar tu plan en renbotia.com.`;
    }
    const faq = { question: args.pregunta, answer: args.respuesta };
    const issues = await validateTrainingConfig({ faqs: [faq] });
    if (issues.length) return `No la agregué: ${issues[0]?.reason || 'ese contenido no sirve como pregunta frecuente'}.`;
    cfg.faqs.push(faq);
    await cfg.save();
    return 'Listo, el bot ya sabe responder esa pregunta.';
  }
  return 'No reconocí esa acción.';
}

/** Lee la acción pendiente vigente de este número (o null). */
async function livePending(businessId, waId) {
  const b = await Business.findById(businessId).select('ownerPending').lean();
  const p = b?.ownerPending;
  if (!p?.action || p.waId !== waId) return null;
  return { ...p, expired: !p.expiresAt || new Date(p.expiresAt).getTime() <= Date.now() };
}

async function confirmPending(ctx) {
  const pending = await livePending(ctx.business._id, ctx.waId);
  if (!pending) return { ok: false, mensaje: 'No hay nada pendiente de confirmar.' };
  await Business.updateOne({ _id: ctx.business._id }, { $set: { 'ownerPending.action': '' } });
  if (pending.expired) return { ok: false, mensaje: 'Esa confirmación ya venció (pasaron más de 15 minutos). Dime de nuevo qué hago y lo preparo.' };
  const mensaje = await executePending(ctx.business, pending, ctx.tz);
  audit(ctx, pending.action, pending.summary);
  ctx.pendingSummary = ''; // ya se hizo: no volver a pedir el SÍ
  return { ok: true, mensaje };
}

/** Acciones que se aplican al momento (reversibles o de bajo riesgo). */
async function runImmediate(name, input, ctx) {
  const { business, tz } = ctx;
  if (name === 'reanudar_bot') {
    const canal = input.canal || 'todos';
    await setPause(business, canal, false);
    const label = canal === 'todos' ? ALL_LABEL : CHANNELS[canal];
    audit(ctx, 'reanudar_bot', `Reactivar el bot en ${label}`);
    return { ok: true, mensaje: `Listo, el bot ya está respondiendo en ${label}.` };
  }
  if (name === 'quitar_aviso') {
    const r = await runReadTool('ver_avisos', {}, ctx);
    const n = r.avisos.find((a) => a.numero === Number(input.numero));
    if (!n) return { ok: false, error: 'No hay un aviso con ese número.' };
    await BotConfig.updateOne({ business: business._id }, { $pull: { notices: { text: n.texto } } });
    audit(ctx, 'quitar_aviso', `Quitar el aviso "${n.texto}"`);
    return { ok: true, mensaje: `Listo, quité el aviso "${n.texto}".` };
  }
  if (name === 'cambiar_estado_registro') {
    if (!/^[a-f0-9]{24}$/i.test(String(input.id || ''))) return { ok: false, error: 'Id no válido; consulta ver_agenda.' };
    if (!STATUS_LABEL[input.estado]) return { ok: false, error: 'Estado no válido.' };
    const rec = await ManagedRecord.findOne({ _id: input.id, business: business._id });
    if (!rec) return { ok: false, error: 'No encontré ese registro.' };
    rec.status = input.estado;
    await rec.save();
    const what = `${RECORD_TYPE_META[rec.type]?.label || 'Registro'}${rec.customer?.name ? ` de ${rec.customer.name}` : ''}${rec.scheduledAt ? ` (${fmtLocal(tz, rec.scheduledAt)})` : ''}`;
    audit(ctx, 'registro', `${what} → ${input.estado}`);
    return { ok: true, mensaje: `Listo: ${what} quedó *${input.estado}*.` };
  }
  if (name === 'confirmar_accion') return confirmPending(ctx);
  if (name === 'cancelar_accion') {
    await Business.updateOne({ _id: business._id }, { $set: { 'ownerPending.action': '' } });
    ctx.pendingSummary = '';
    return { ok: true, mensaje: 'Cancelado, no cambié nada.' };
  }
  return { error: 'herramienta desconocida' };
}

/** Ejecuta una herramienta pedida por el modelo (lista blanca). */
export async function runOwnerTool(name, input, ctx) {
  if (!TOOLS.some((t) => t.name === name)) return { error: 'herramienta no permitida' };
  ctx.used = [...(ctx.used || []), name];
  let out;
  if (NEEDS_CONFIRM.has(name)) out = await prepareAction(name, input || {}, ctx);
  else if (IMMEDIATE.has(name)) out = await runImmediate(name, input || {}, ctx);
  else out = await runReadTool(name, input || {}, ctx);
  if (out?.mensaje) ctx.notes.push(out.mensaje);
  return out;
}

/* ── Mensaje del dueño ─────────────────────────────────────────────────────── */

// Confirmación directa (sin pasar por la IA): solo frases cortas inequívocas.
const YES_RE = /^(si|sip|claro|dale|va|ok|okay|adelante|hazlo|confirmo|confirmar|de acuerdo|perfecto|correcto)( (si|por favor|porfa|hazlo|adelante|confirmo|gracias|dale))*$/;
const NO_RE = /^(no|nop|cancela|cancelar|mejor no|no gracias|olvidalo|dejalo|dejalo asi)$/;
const MODE_RE = /^(?:(?:cambia(?:r)? a|pasa(?:r)? a|activa(?:r)?(?: el)?|entra(?:r)? (?:al|en)|vuelve a|volver a|regresa(?:r)? a) )?modo (cliente|dueno)$/;

const HISTORY_TURNS = 12;
const HISTORY_WINDOW_MS = 3 * 60 * 60 * 1000; // charla reciente; lo viejo ya no aplica

// Puntos de prueba: las pruebas automáticas cambian el envío y la IA.
let deps = { send: sendText, ai: generateReplyWithTools };
export function __setOwnerTestHooks(hooks) {
  deps = { send: sendText, ai: generateReplyWithTools, ...(hooks || {}) };
}

async function say(business, phoneNumberId, waId, text, { remember = true } = {}) {
  await deps.send({ phoneNumberId: phoneNumberId || business.whatsappPhoneNumberId, to: waId, text });
  if (remember) await OwnerMessage.create({ business: business._id, waId, role: 'assistant', text: text.slice(0, 4000) }).catch(() => {});
}

/** Últimos mensajes recientes de la charla, listos para la IA (alternados). */
async function recentHistory(businessId, waId) {
  const rows = await OwnerMessage.find({ business: businessId, waId, createdAt: { $gte: new Date(Date.now() - HISTORY_WINDOW_MS) } })
    .sort({ createdAt: -1 })
    .limit(HISTORY_TURNS)
    .lean();
  const out = [];
  for (const r of rows.reverse()) {
    const last = out[out.length - 1];
    if (last && last.role === r.role) last.content += `\n${r.text}`;
    else out.push({ role: r.role, content: r.text });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

function systemPrompt({ business, tz, pausedLine, pending }) {
  const { h, m } = localParts(tz);
  return `Eres el asistente personal de administración de RenBotIA para el DUEÑO de "${business.name}". Te escribe desde su WhatsApp. Actúa como un asistente de confianza: entiende lo que quiere aunque lo diga a medias, usa lo que ya se habló en esta charla y resuelve en vez de mandar menús.
Hora local del negocio: ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}.
Estado ahora: ${pausedLine}.${pending ? `\nAcción pendiente de su confirmación: ${pending}. Si en su último mensaje acepta (aunque sea con otras palabras), usa confirmar_accion; si la rechaza o dice que era prueba, usa cancelar_accion; si pide un cambio, prepara la acción de nuevo con el ajuste.` : ''}

Cómo responder:
- Español de México, breve (máximo 6 líneas), cálido y directo. Negritas con *texto* (un asterisco, formato de WhatsApp); nunca ** ni otro Markdown. Máximo un emoji.
- Si la intención es clara, actúa: usa la herramienta y di qué hiciste. Pregunta solo si de verdad falta un dato, y una sola pregunta.
- Respuestas cortas como "en todos", "a las 6", "sí" o "el de Laura" completan lo último que se habló.
- "Cancela la pausa", "quita la pausa" o "ya no lo pauses" con el bot en pausa = reactivarlo (reanudar_bot). Solo es cancelar_accion si hay una acción pendiente.
- Si pide reactivar sin decir canal, reactiva todos ("todos").
- Antes de que responda SÍ, habla en futuro ("Voy a pausar…", "Agrego este aviso…"); en pasado solo lo que ya hizo una herramienta.
- Solo las herramientas cambian cosas. Nunca digas que pausaste, reactivaste, agregaste, quitaste o confirmaste algo si no llamaste la herramienta en este turno.
- "Todos los canales" = WhatsApp, Messenger, Instagram y el chat del sitio web (canal sitio_web). Horas en 24 h para las herramientas (6 de la tarde = 18:00).
- No inventes cifras ni estados: consulta con las herramientas. Si pregunta si el bot está activo o pausado, usa ver_estado.
- Pausar, agregar avisos y agregar preguntas: llama SIEMPRE la herramienta en ese mismo turno (así queda lista) y luego pide que responda *SÍ*; nunca pidas el SÍ sin haberla llamado. Reactivar el bot, quitar avisos y cambiar el estado de la agenda se aplican al momento: confírmalo en una línea.
- Nunca respondas vacío: si ya estaba hecho lo que pide, dilo (ej. "Ya está activo en todos tus canales").
- No ofrezcas la lista de lo que puedes hacer salvo que te lo pida o salude por primera vez.

Límites (por seguridad): no puedes facturación, planes, pagos, tarjetas, borrar datos, desconectar canales, ver contraseñas o tokens, ni escribir a clientes. Para eso, guíalo al panel en renbotia.com: Entrenamiento (preguntas, tono, horario), Conversaciones (responder y tomar el control), Gestión (agenda), Conexiones (canales y este WhatsApp), Equipo, Facturación (plan, tarjeta y créditos).`;
}

/**
 * Atiende un mensaje del dueño. Devuelve true si lo atendió (el webhook no debe
 * pasarlo al bot de clientes) o false si está en "modo cliente".
 */
export async function handleOwnerMessage({ business: base, waId, msg, phoneNumberId }) {
  const business = await Business.findById(base._id);
  if (!business) return true;
  const entry = ownerEntry(business, waId);
  if (!entry) return false;
  const text = msg.type === 'text' ? String(msg.text?.body || '').trim() : '';
  const n = norm(text);
  const mode = MODE_RE.exec(n)?.[1];

  // Modo cliente: el dueño prueba su bot como si fuera cliente durante 30 min.
  if (entry.customerModeUntil && new Date(entry.customerModeUntil).getTime() > Date.now()) {
    if (mode === 'dueno') {
      await Business.updateOne({ _id: business._id, 'ownerWhatsApp.waId': waId }, { $unset: { 'ownerWhatsApp.$.customerModeUntil': '' } });
      await say(business, phoneNumberId, waId, 'Volviste al *modo dueño*. ¿En qué te ayudo?');
      return true;
    }
    return false;
  }

  // Vence por inactividad (30 días sin usarlo).
  if (Date.now() - new Date(entry.lastUsedAt || entry.linkedAt).getTime() > INACTIVE_MS) {
    await Business.updateOne({ _id: business._id }, { $pull: { ownerWhatsApp: { waId } } });
    await say(business, phoneNumberId, waId, 'Tu vinculación venció por 30 días sin uso. Vuelve a vincular este número desde tu panel: Conexiones → WhatsApp.', { remember: false });
    return true;
  }
  await Business.updateOne({ _id: business._id, 'ownerWhatsApp.waId': waId }, { $set: { 'ownerWhatsApp.$.lastUsedAt': new Date() } });

  if (!text) {
    await say(business, phoneNumberId, waId, 'Por ahora entiendo solo mensajes de texto. Escríbeme lo que necesitas.', { remember: false });
    return true;
  }
  if (mode === 'cliente') {
    await Business.updateOne(
      { _id: business._id, 'ownerWhatsApp.waId': waId },
      { $set: { 'ownerWhatsApp.$.customerModeUntil': new Date(Date.now() + CUSTOMER_MODE_MS) } }
    );
    await say(business, phoneNumberId, waId, 'Durante 30 minutos te contesto como a un cliente, para que pruebes tu bot. Escribe *modo dueño* para volver.');
    return true;
  }
  if (mode === 'dueno') {
    await say(business, phoneNumberId, waId, 'Ya estás en *modo dueño*. ¿En qué te ayudo?');
    return true;
  }

  await OwnerMessage.create({ business: business._id, waId, role: 'user', text: text.slice(0, 1000) }).catch(() => {});
  const tz = (await BotConfig.findOne({ business: business._id }).select('schedule.timezone').lean())?.schedule?.timezone || 'America/Mexico_City';
  const ctx = { business, waId, tz, sub: null, pendingSummary: '', notes: [] };

  // Confirmación directa de una acción pendiente ("sí", "dale", "no").
  const pending = await livePending(business._id, waId);
  if (pending && (YES_RE.test(n) || NO_RE.test(n))) {
    if (NO_RE.test(n)) {
      await Business.updateOne({ _id: business._id }, { $set: { 'ownerPending.action': '' } });
      await say(business, phoneNumberId, waId, 'Cancelado, no cambié nada.');
    } else {
      const r = await confirmPending(ctx);
      await say(business, phoneNumberId, waId, r.mensaje);
    }
    return true;
  }

  // Tope diario de mensajes al asistente.
  const day = new Date().toISOString().slice(0, 10);
  const used = business.ownerUsage?.day === day ? business.ownerUsage.count : 0;
  if (used >= DAILY_CAP) {
    await say(business, phoneNumberId, waId, 'Llegaste al límite de mensajes de hoy con tu asistente. Mañana seguimos, o entra a tu panel en renbotia.com.', { remember: false });
    return true;
  }
  await Business.updateOne({ _id: business._id }, { $set: { ownerUsage: { day, count: used + 1 } } });

  const sub = await Subscription.findOne({ business: business._id }).populate('plan');
  if (!sub) return true;
  await applyLazyReset(sub);
  if (!hasBalance(sub, 1)) {
    await say(business, phoneNumberId, waId, 'Tu bot se quedó sin saldo este mes. Recarga en tu panel para seguir usándolo.', { remember: false });
    return true;
  }
  ctx.sub = sub;

  const states = pauseState(business, tz);
  const paused = states.filter((s) => s.bot !== 'activo');
  const pausedLine = paused.length
    ? `${paused.map((s) => `${s.canal} ${s.bot}`).join('; ')}${paused.length < states.length ? '; el resto activo' : ''}`
    : 'el bot está activo en todos sus canales';
  // El asistente del dueño maneja su negocio: usa el modelo más confiable en
  // todos los planes (es poco volumen: máx. DAILY_CAP mensajes al día).
  const model = OWNER_MODEL;
  const history = await recentHistory(business._id, waId);
  const messages = history.length && history[history.length - 1].role === 'user' ? history : [...history, { role: 'user', content: text.slice(0, 1000) }];

  const system = systemPrompt({ business, tz, pausedLine, pending: pending && !pending.expired ? pending.summary : '' });
  const executeTool = (name, input) => runOwnerTool(name, input, ctx);
  let result;
  try {
    result = await deps.ai({ system, messages, tools: TOOLS, model, executeTool });
    // Candado: si afirma haber cambiado algo sin usar la herramienta, se le
    // corrige una vez (nunca le decimos al dueño que se hizo algo que no pasó).
    if (claimsUnbackedAction(result.text, ctx)) {
      const retry = await deps.ai({
        system,
        messages: [
          ...messages,
          { role: 'assistant', content: result.text },
          {
            role: 'user',
            content:
              '[Aviso del sistema, no del dueño] No llamaste ninguna herramienta en ese turno, así que NADA cambió. Si el dueño pidió una acción, llama ahora la herramienta correcta; si no, corrige tu respuesta sin afirmar cambios.',
          },
        ],
        tools: TOOLS,
        model,
        executeTool,
      });
      for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'totalTokens', 'billableTokens']) {
        result[k] = (result[k] || 0) + (retry[k] || 0);
      }
      result.text = retry.text;
    }
  } catch (err) {
    logger.warn(`Dueño por WhatsApp: IA no disponible: ${err.message}`);
    await say(business, phoneNumberId, waId, 'En este momento no puedo responder. Intenta en unos minutos.', { remember: false });
    return true;
  }

  await deductTokens(sub, result.billableTokens ?? result.totalTokens);
  void UsageLog.create({
    business: business._id,
    date: new Date(),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheReadTokens: result.cacheReadTokens,
    cacheCreationTokens: result.cacheCreationTokens,
    totalTokens: result.totalTokens,
    model,
    source: 'owner',
  });

  await say(business, phoneNumberId, waId, composeReply(result.text, ctx).slice(0, 3500));
  return true;
}

const CHANGE_TOOLS = new Set([...NEEDS_CONFIRM, ...IMMEDIATE]);
const ACTION_CLAIM =
  /(?<![a-zà-ÿ])(pausé|reactivé|agregué|quité|confirmé|activé)(?![a-zà-ÿ])|qued[oó] (en pausa|pausad|confirmad|reactivad|activ)|ya (est[aá]|qued[oó]) (pausad|en pausa|confirmad|reactivad)/i;

/** ¿El texto dice que se hizo un cambio sin que se usara una herramienta que cambia algo? */
export function claimsUnbackedAction(text, ctx) {
  if (!text || ctx.pendingSummary) return false;
  if ((ctx.used || []).some((n) => CHANGE_TOOLS.has(n))) return false;
  return ACTION_CLAIM.test(text);
}

/**
 * Texto final para el dueño: nunca vacío ni "(sin respuesta)"; si quedó algo
 * pendiente, siempre termina pidiendo el SÍ.
 */
export function composeReply(aiText, ctx) {
  let out = String(aiText || '').trim();
  if (out === '(sin respuesta)') out = '';
  if (!out) out = ctx.notes.join('\n');
  // ¿Ya pide el SÍ? (\b no sirve con la Í acentuada)
  if (ctx.pendingSummary && !/(^|[^A-Za-zÀ-ÿ])S[IÍ](?![A-Za-zÀ-ÿ])/.test(out)) {
    out = `${out ? `${out}\n\n` : ''}${ctx.pendingSummary}. ¿Lo hago? Responde *SÍ* o dime qué cambiar.`;
  }
  return out || 'Listo.';
}

/** Estado para el panel (números enmascarados). */
export function ownerControlView(business) {
  return {
    linked: (business.ownerWhatsApp || []).map((o) => ({
      id: crypto.createHash('sha256').update(o.waId).digest('hex').slice(0, 12),
      number: maskWaId(o.waId),
      linkedAt: o.linkedAt,
      lastUsedAt: o.lastUsedAt,
    })),
    maxNumbers: MAX_NUMBERS,
    codeExpiresAt:
      business.ownerLinkCode?.expiresAt && new Date(business.ownerLinkCode.expiresAt).getTime() > Date.now()
        ? business.ownerLinkCode.expiresAt
        : null,
  };
}

/** Quita un número vinculado (por su id enmascarado). */
export async function unlinkOwnerNumber(businessId, id) {
  const business = await Business.findById(businessId);
  const entry = (business?.ownerWhatsApp || []).find(
    (o) => crypto.createHash('sha256').update(o.waId).digest('hex').slice(0, 12) === id
  );
  if (!entry) return false;
  await Business.updateOne({ _id: businessId }, { $pull: { ownerWhatsApp: { waId: entry.waId } } });
  return maskWaId(entry.waId);
}

export { isChannelPaused };
