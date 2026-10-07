import crypto from 'node:crypto';
import { Business } from '../models/Business.js';
import { BotConfig } from '../models/BotConfig.js';
import { Subscription } from '../models/Subscription.js';
import { ChatSimulation } from '../models/ChatSimulation.js';
import { LearningSuggestion } from '../models/LearningSuggestion.js';
import { UsageLog } from '../models/UsageLog.js';
import { User } from '../models/User.js';
import '../models/Plan.js';
import { MODEL_BY_PLAN } from '../config/constants.js';
import { getPlanLimits } from '../utils/planGating.js';
import { isChannelPaused } from '../utils/botAvailability.js';
import { generateReplyWithTools } from './claude.service.js';
import { applyLazyReset, hasBalance, deductTokens } from './token.service.js';
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
 *  - El asistente solo tiene herramientas acotadas (resumen, leads, pendientes,
 *    pausar/reanudar, avisos temporales, agregar preguntas). Nada de facturación,
 *    planes, borrar datos ni desconectar canales. Todo lo que CAMBIA algo pide
 *    confirmación ("sí") y queda en la bitácora.
 *  - Los mensajes del dueño nunca se mezclan con las conversaciones de clientes.
 */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /^\s*RB-([A-Z0-9]{8})\s*$/i;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_NUMBERS = 2;
const MAX_FAILURES = 5;
const INACTIVE_MS = 30 * 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 5 * 60 * 1000;
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
  return sendText({ phoneNumberId: phoneNumberId || business.whatsappPhoneNumberId, to, text });
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
    `*¡Listo!* Este número ya maneja el bot de ${business.name}.\n\nPuedes escribirme cosas como:\n• ¿Cómo vamos hoy?\n• Pásame los leads\n• Pausa el bot hasta las 6\n• Hoy cerramos a las 4\n• Agrega: ¿hacen envíos? Sí, gratis desde $500\n\nPara hablar con tu bot como cliente escribe *modo cliente*.`
  );
}

/** ¿Este número es del dueño (vinculado y vigente)? */
export function ownerEntry(business, waId) {
  return (business.ownerWhatsApp || []).find((o) => o.waId === waId) || null;
}

/* ── Herramientas del asistente ────────────────────────────────────────────── */

const CHANNELS = { whatsapp: 'WhatsApp', messenger: 'Messenger', instagram: 'Instagram' };
const KEY_OF = { whatsapp: 'whatsapp', messenger: 'facebook', instagram: 'instagram' };

/** Partes de la hora local del negocio. */
function localParts(tz, date = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return { h: Number(p.find((x) => x.type === 'hour').value), m: Number(p.find((x) => x.type === 'minute').value) };
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
function endOfLocalDay(tz, extraDays = 0) {
  const { h, m } = localParts(tz);
  return new Date(Date.now() + ((24 * 60 - (h * 60 + m)) - 1 + extraDays * 24 * 60) * 60 * 1000);
}
const fmtLocal = (tz, d) =>
  new Intl.DateTimeFormat('es-MX', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit' })
    .format(d)
    .replace(/\.$/, ''); // "p.m." sin el punto final, para no duplicarlo en las frases

const TOOLS = [
  {
    name: 'ver_resumen',
    description: 'Resumen de resultados del bot (conversaciones, leads, citas/pedidos, valor estimado, fuera de horario).',
    input_schema: { type: 'object', properties: { periodo: { type: 'string', enum: ['hoy', 'semana', 'mes'] } }, required: ['periodo'] },
  },
  {
    name: 'ver_leads',
    description: 'Leads calientes abiertos (clientes con alta intención de compra) para darles seguimiento.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'ver_pendientes',
    description: 'Conversaciones que requieren atención y preguntas que el bot aún no sabe responder.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'pausar_bot',
    description: 'Pausa al bot (los mensajes llegan a la bandeja y los contesta una persona). Requiere confirmación del dueño.',
    input_schema: {
      type: 'object',
      properties: {
        canal: { type: 'string', enum: ['whatsapp', 'messenger', 'instagram', 'todos'] },
        hasta: { type: 'string', description: 'Hora local HH:MM en que se reactiva solo (opcional).' },
        minutos: { type: 'number', description: 'O cuántos minutos dura la pausa (opcional).' },
      },
      required: ['canal'],
    },
  },
  {
    name: 'reanudar_bot',
    description: 'Reactiva al bot en un canal o en todos. Requiere confirmación.',
    input_schema: { type: 'object', properties: { canal: { type: 'string', enum: ['whatsapp', 'messenger', 'instagram', 'todos'] } }, required: ['canal'] },
  },
  {
    name: 'agregar_aviso',
    description: 'Agrega un aviso temporal que el bot comunicará a los clientes (ej. "hoy cerramos a las 4", "ya no hay pastel de chocolate"). Requiere confirmación.',
    input_schema: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'El aviso, breve y claro, como dato del negocio.' },
        vigencia: { type: 'string', enum: ['hoy', 'manana', 'semana', 'indefinido'] },
      },
      required: ['texto', 'vigencia'],
    },
  },
  { name: 'ver_avisos', description: 'Lista los avisos temporales vigentes (numerados).', input_schema: { type: 'object', properties: {} } },
  {
    name: 'quitar_aviso',
    description: 'Quita un aviso vigente por su número (de ver_avisos). Requiere confirmación.',
    input_schema: { type: 'object', properties: { numero: { type: 'number' } }, required: ['numero'] },
  },
  {
    name: 'agregar_pregunta',
    description: 'Agrega una pregunta frecuente con su respuesta al entrenamiento del bot. Requiere confirmación.',
    input_schema: {
      type: 'object',
      properties: { pregunta: { type: 'string' }, respuesta: { type: 'string' } },
      required: ['pregunta', 'respuesta'],
    },
  },
];

const MUTATING = new Set(['pausar_bot', 'reanudar_bot', 'agregar_aviso', 'quitar_aviso', 'agregar_pregunta']);
const money = (n) => `$${Math.round(n || 0).toLocaleString('es-MX')}`;

async function runReadTool(name, input, ctx) {
  const { business } = ctx;
  if (name === 'ver_resumen') {
    const now = new Date();
    const since =
      input.periodo === 'hoy'
        ? new Date(now.getTime() - (localParts(ctx.tz).h * 60 + localParts(ctx.tz).m) * 60 * 1000)
        : input.periodo === 'semana'
          ? new Date(now.getTime() - 7 * 864e5)
          : new Date(now.getFullYear(), now.getMonth(), 1);
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
        canal: { whatsapp: 'WhatsApp', facebook: 'Messenger', instagram: 'Instagram', web: 'Sitio web' }[l.channel] || l.channel,
        cuando: l.hotLeadAt ? fmtLocal(ctx.tz, new Date(l.hotLeadAt)) : '',
      })),
    };
  }
  if (name === 'ver_pendientes') {
    const [attention, learning] = await Promise.all([
      ChatSimulation.countDocuments({ business: business._id, needsAttention: true, channel: { $ne: 'simulator' } }),
      LearningSuggestion.find({ business: business._id, status: 'pending' }).sort({ updatedAt: -1 }).limit(5).select('question').lean(),
    ]);
    return { requieren_atencion: attention, el_bot_no_sabe: learning.map((s) => s.question) };
  }
  if (name === 'ver_avisos') {
    const cfg = await BotConfig.findOne({ business: business._id }).select('notices').lean();
    const now = Date.now();
    const list = (cfg?.notices || []).filter((n) => !n.until || new Date(n.until).getTime() > now);
    return {
      avisos: list.map((n, i) => ({ numero: i + 1, texto: n.text, vence: n.until ? fmtLocal(ctx.tz, new Date(n.until)) : 'sin fecha' })),
    };
  }
  return { error: 'herramienta desconocida' };
}

/** Prepara una acción que cambia algo: queda pendiente del "sí" del dueño. */
async function prepareAction(name, input, ctx) {
  const { business, tz } = ctx;
  let summary = '';
  let args = { ...input };
  if (name === 'pausar_bot' || name === 'reanudar_bot') {
    const canal = input.canal || 'todos';
    const label = canal === 'todos' ? 'todos los canales' : CHANNELS[canal];
    if (name === 'pausar_bot') {
      const until = input.hasta ? nextLocalTime(tz, input.hasta) : input.minutos ? new Date(Date.now() + Math.min(Math.max(Number(input.minutos), 5), 7 * 24 * 60) * 60000) : null;
      if (input.hasta && !until) return { ok: false, error: 'Hora no válida. Usa formato HH:MM.' };
      args = { canal, until: until ? until.toISOString() : null };
      summary = `Pausar el bot en ${label}${until ? ` hasta ${fmtLocal(tz, until)}` : ' hasta que lo reactives'}`;
    } else {
      args = { canal };
      summary = `Reactivar el bot en ${label}`;
    }
  } else if (name === 'agregar_aviso') {
    const texto = String(input.texto || '').trim().slice(0, 200);
    if (texto.length < 3) return { ok: false, error: 'El aviso está vacío.' };
    const until =
      input.vigencia === 'hoy' ? endOfLocalDay(tz) : input.vigencia === 'manana' ? endOfLocalDay(tz, 1) : input.vigencia === 'semana' ? new Date(Date.now() + 7 * 864e5) : null;
    args = { texto, until: until ? until.toISOString() : null };
    summary = `Agregar el aviso "${texto}"${until ? ` (vence ${fmtLocal(tz, until)})` : ' (sin fecha de vencimiento)'}`;
  } else if (name === 'quitar_aviso') {
    const r = await runReadTool('ver_avisos', {}, ctx);
    const n = r.avisos.find((a) => a.numero === Number(input.numero));
    if (!n) return { ok: false, error: 'No hay un aviso con ese número.' };
    args = { texto: n.texto };
    summary = `Quitar el aviso "${n.texto}"`;
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
  return { ok: true, pendiente_de_confirmacion: summary, instruccion: 'Pide al dueño que responda SÍ para confirmar.' };
}

/** Ejecuta la acción confirmada. Devuelve el texto para el dueño. */
async function executePending(business, pending, tz) {
  const { action, args } = pending;
  if (action === 'pausar_bot' || action === 'reanudar_bot') {
    const keys = args.canal === 'todos' ? Object.values(KEY_OF) : [KEY_OF[args.canal]];
    const set = {};
    for (const k of keys) {
      set[`channelSettings.${k}.paused`] = action === 'pausar_bot';
      set[`channelSettings.${k}.pausedUntil`] = action === 'pausar_bot' && args.until ? new Date(args.until) : null;
    }
    await Business.updateOne({ _id: business._id }, { $set: set });
    return action === 'pausar_bot'
      ? `Listo, el bot quedó en pausa${args.until ? ` hasta ${fmtLocal(tz, new Date(args.until))}` : ''}. Los mensajes llegan a tu bandeja.`
      : 'Listo, el bot ya está respondiendo de nuevo.';
  }
  if (action === 'agregar_aviso') {
    await BotConfig.updateOne(
      { business: business._id },
      { $push: { notices: { $each: [{ text: args.texto, until: args.until ? new Date(args.until) : null, via: 'whatsapp' }], $slice: -10 } } }
    );
    return 'Listo, el bot ya lo sabe y lo dirá a tus clientes cuando aplique.';
  }
  if (action === 'quitar_aviso') {
    await BotConfig.updateOne({ business: business._id }, { $pull: { notices: { text: args.texto } } });
    return 'Listo, quité ese aviso.';
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

/* ── Mensaje del dueño ─────────────────────────────────────────────────────── */

const YES = new Set(['si', 'sí', 'si confirmo', 'confirmo', 'confirmar', 'si por favor', 'dale', 'ok', 'va', 'claro', 'si adelante']);
const NO = new Set(['no', 'cancelar', 'cancela', 'mejor no', 'no gracias']);

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

  // Modo cliente: el dueño prueba su bot como si fuera cliente durante 30 min.
  if (entry.customerModeUntil && new Date(entry.customerModeUntil).getTime() > Date.now()) {
    if (n === 'modo dueno') {
      await Business.updateOne({ _id: business._id, 'ownerWhatsApp.waId': waId }, { $unset: { 'ownerWhatsApp.$.customerModeUntil': '' } });
      await reply(business, phoneNumberId, waId, 'Volviste al *modo dueño*. ¿En qué te ayudo?');
      return true;
    }
    return false;
  }

  // Vence por inactividad (30 días sin usarlo).
  if (Date.now() - new Date(entry.lastUsedAt || entry.linkedAt).getTime() > INACTIVE_MS) {
    await Business.updateOne({ _id: business._id }, { $pull: { ownerWhatsApp: { waId } } });
    await reply(business, phoneNumberId, waId, 'Tu vinculación venció por 30 días sin uso. Vuelve a vincular este número desde tu panel: Conexiones → WhatsApp.');
    return true;
  }
  await Business.updateOne({ _id: business._id, 'ownerWhatsApp.waId': waId }, { $set: { 'ownerWhatsApp.$.lastUsedAt': new Date() } });

  if (!text) {
    await reply(business, phoneNumberId, waId, 'Por ahora entiendo solo mensajes de texto.');
    return true;
  }
  if (n === 'modo cliente') {
    await Business.updateOne(
      { _id: business._id, 'ownerWhatsApp.waId': waId },
      { $set: { 'ownerWhatsApp.$.customerModeUntil': new Date(Date.now() + CUSTOMER_MODE_MS) } }
    );
    await reply(business, phoneNumberId, waId, 'Durante 30 minutos te contesto como a un cliente, para que pruebes tu bot. Escribe *modo dueño* para volver.');
    return true;
  }

  const tz = (await BotConfig.findOne({ business: business._id }).select('schedule.timezone').lean())?.schedule?.timezone || 'America/Mexico_City';

  // Confirmación de una acción pendiente.
  const pending = business.ownerPending;
  if (pending?.action && pending.waId === waId && pending.expiresAt && new Date(pending.expiresAt).getTime() > Date.now()) {
    if (YES.has(n)) {
      await Business.updateOne({ _id: business._id }, { $set: { 'ownerPending.action': '' } });
      const result = await executePending(business, pending, tz);
      void logAudit({
        businessId: business._id,
        userId: business.owner,
        action: `owner.whatsapp.${pending.action}`,
        summary: `Desde WhatsApp (${maskWaId(waId)}): ${pending.summary}.`,
      });
      await reply(business, phoneNumberId, waId, result);
      return true;
    }
    await Business.updateOne({ _id: business._id }, { $set: { 'ownerPending.action': '' } });
    if (NO.has(n)) {
      await reply(business, phoneNumberId, waId, 'Cancelado, no cambié nada.');
      return true;
    }
  }

  // Tope diario de mensajes al asistente.
  const day = new Date().toISOString().slice(0, 10);
  const used = business.ownerUsage?.day === day ? business.ownerUsage.count : 0;
  if (used >= DAILY_CAP) {
    await reply(business, phoneNumberId, waId, 'Llegaste al límite de mensajes de hoy con tu asistente. Mañana seguimos, o entra a tu panel en renbotia.com.');
    return true;
  }
  await Business.updateOne({ _id: business._id }, { $set: { ownerUsage: { day, count: used + 1 } } });

  const sub = await Subscription.findOne({ business: business._id }).populate('plan');
  if (!sub) return true;
  await applyLazyReset(sub);
  if (!hasBalance(sub, 1)) {
    await reply(business, phoneNumberId, waId, 'Tu bot se quedó sin saldo este mes. Recarga en tu panel para seguir usándolo.');
    return true;
  }

  const ctx = { business, waId, tz, pendingSummary: '' };
  const { h, m } = localParts(tz);
  const system = `Eres el asistente de administración de RenBotIA para el DUEÑO del negocio "${business.name}", que te escribe desde su WhatsApp personal.
Hora local del negocio: ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}.
Responde en español de México, breve (máximo 6 líneas), claro y amable. Para negritas usa *texto* con UN asterisco (formato de WhatsApp); nunca uses ** ni otro Markdown. Máximo un emoji por mensaje.
Usa las herramientas para consultar datos o preparar cambios. NO inventes cifras: solo usa lo que regresan las herramientas.
Solo puedes: dar resúmenes, leads calientes y pendientes; pausar o reactivar el bot; agregar, listar o quitar avisos temporales; agregar preguntas frecuentes.
NO puedes: facturación, planes, pagos, borrar datos, desconectar canales, ver contraseñas o tokens, ni escribir a clientes. Si lo pide, dile que lo haga en su panel en renbotia.com.
Cuando una herramienta deja algo "pendiente de confirmación", explica en una línea qué se hará y pide que responda *SÍ* para confirmar.
Si saluda o pide ayuda, menciona brevemente lo que puedes hacer.`;

  let result;
  try {
    result = await generateReplyWithTools({
      system,
      messages: [{ role: 'user', content: text.slice(0, 1000) }],
      tools: TOOLS,
      model: MODEL_BY_PLAN.free,
      executeTool: async (name, input) => {
        if (!TOOLS.some((t) => t.name === name)) return { error: 'herramienta no permitida' };
        return MUTATING.has(name) ? prepareAction(name, input || {}, ctx) : runReadTool(name, input || {}, ctx);
      },
    });
  } catch (err) {
    logger.warn(`Dueño por WhatsApp: IA no disponible: ${err.message}`);
    await reply(business, phoneNumberId, waId, 'En este momento no puedo responder. Intenta en unos minutos.');
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
    model: MODEL_BY_PLAN.free,
    source: 'owner',
  });

  let out = (result.text || '').trim() || 'Listo.';
  if (ctx.pendingSummary && !/s[ií]/i.test(out.slice(-80))) out += `\n\n${ctx.pendingSummary}. Responde *SÍ* para confirmar.`;
  await reply(business, phoneNumberId, waId, out.slice(0, 3500));
  return true;
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
