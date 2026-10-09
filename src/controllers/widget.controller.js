import crypto from 'node:crypto';
import { isBlocked } from '../utils/blocklist.js';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { Business } from '../models/Business.js';
import { BotConfig } from '../models/BotConfig.js';
import { Subscription } from '../models/Subscription.js';
import { ChatSimulation } from '../models/ChatSimulation.js';
import { PLAN_LIMITS } from '../config/constants.js';
import { processMessage } from '../services/simulator.service.js';
import { logAudit } from '../services/audit.service.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import { inboundFileSchema, parseUploadedFile } from '../utils/inboundFile.js';

/**
 * Widget web: chat del bot incrustable en el sitio del negocio (Pro/Elite).
 *
 * El snippet (`/widget.js`) dibuja el botón flotante en el sitio del cliente y
 * abre un iframe de renbotia.com (`/w/:key`). Toda la conversación ocurre dentro
 * del iframe, así que estas rutas públicas se consumen same-origin; solo la
 * config pública admite CORS abierto (la lee el snippet desde el sitio ajeno).
 *
 * Identidad del visitante: un `sessionId` aleatorio que genera el iframe y guarda
 * en su almacenamiento. Cada sesión = una conversación (channel 'web').
 */

const KEY_RE = /^[A-Za-z0-9_-]{16,40}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{16,64}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
// Tope de mensajes por sesión en 24 h: corta el abuso que vaciaría los créditos
// del negocio sin molestar a un visitante real.
const SESSION_DAILY_CAP = 60;
// Archivos (foto o PDF) por sesión en 24 h: leerlos cuesta más créditos.
const SESSION_FILE_CAP = 10;

const newKey = () => crypto.randomBytes(15).toString('base64url'); // 20 chars

async function getPlanKey(businessId) {
  const sub = await Subscription.findOne({ business: businessId }).populate('plan', 'key');
  return sub?.plan?.key || 'free';
}

function widgetView(business, planKey) {
  const w = business?.widget || {};
  return {
    allowed: Boolean(PLAN_LIMITS[planKey]?.webWidget),
    planKey,
    enabled: Boolean(w.enabled),
    key: w.key || '',
    color: w.color || '#4f46e5',
    greeting: w.greeting || '',
    position: w.position || 'right',
    suggestions: w.suggestions || [],
    autoOpenSeconds: w.autoOpenSeconds || 0,
    requireContact: Boolean(w.requireContact),
    allowedDomains: w.allowedDomains || [],
    hideOnMobile: Boolean(w.hideOnMobile),
    buttonText: w.buttonText || '',
  };
}

/**
 * Normaliza un dominio escrito por el dueño ("https://www.misitio.com/contacto"
 * → "misitio.com"). Devuelve '' si no parece un dominio.
 */
export function normalizeDomain(input) {
  const host = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .split(/[/?#:]/)[0]
    .replace(/^www\./, '');
  return /^(?=.{3,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/.test(host) || host === 'localhost' ? host : '';
}

// Dominios propios: el chat siempre funciona en renbotia.com (vista de prueba).
const OWN_HOSTS = (() => {
  try {
    return [new URL(env.clientUrl).hostname.replace(/^www\./, '')];
  } catch {
    return [];
  }
})();

/** ¿El sitio `host` puede usar este widget? Sin lista = cualquiera. */
function hostAllowed(business, host) {
  const list = business.widget?.allowedDomains || [];
  if (!list.length) return true;
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  if (!h || OWN_HOSTS.includes(h)) return true;
  return list.some((d) => h === d || h.endsWith(`.${d}`));
}

const hostFromOrigin = (origin) => {
  try {
    return new URL(origin).hostname;
  } catch {
    return '';
  }
};

/* ── Panel (dueño/miembros) ─────────────────────────────────────────────── */

/** GET /api/widget — configuración del widget del negocio activo. */
export const getWidget = asyncHandler(async (req, res) => {
  const business = await Business.findById(req.businessId).select('widget');
  const planKey = await getPlanKey(req.businessId);
  res.json({ success: true, data: widgetView(business, planKey) });
});

export const updateWidgetSchema = z.object({
  enabled: z.boolean().optional(),
  color: z.string().regex(COLOR_RE, 'Color no válido').optional(),
  greeting: z.string().max(200).optional(),
  position: z.enum(['right', 'left']).optional(),
  regenerateKey: z.boolean().optional(),
  suggestions: z.array(z.string().trim().min(2).max(60)).max(4, 'Máximo 4 preguntas sugeridas.').optional(),
  autoOpenSeconds: z.number().int().min(0).max(120).optional(),
  requireContact: z.boolean().optional(),
  allowedDomains: z.array(z.string().trim().max(253)).max(5, 'Máximo 5 dominios.').optional(),
  hideOnMobile: z.boolean().optional(),
  buttonText: z.string().trim().max(30).optional(),
});

/** PUT /api/widget — activa/ajusta el widget (solo dueño). */
export const updateWidget = asyncHandler(async (req, res) => {
  const planKey = await getPlanKey(req.businessId);
  if (!PLAN_LIMITS[planKey]?.webWidget) {
    throw new ApiError(403, 'El widget para tu sitio web está disponible en los planes Pro y Elite.', {
      code: 'PLAN_REQUIRED',
    });
  }
  const business = await Business.findById(req.businessId).select('widget');
  if (!business) throw ApiError.notFound('Negocio no encontrado');

  const { enabled, color, greeting, position, regenerateKey } = req.body;
  const { suggestions, autoOpenSeconds, requireContact, allowedDomains, hideOnMobile, buttonText } = req.body;
  const prevEnabled = Boolean(business.widget?.enabled);
  if (enabled !== undefined) business.widget.enabled = enabled;
  if (color !== undefined) business.widget.color = color;
  if (greeting !== undefined) business.widget.greeting = greeting.trim();
  if (position !== undefined) business.widget.position = position;
  if (suggestions !== undefined) business.widget.suggestions = suggestions;
  if (autoOpenSeconds !== undefined) business.widget.autoOpenSeconds = autoOpenSeconds;
  if (requireContact !== undefined) business.widget.requireContact = requireContact;
  if (hideOnMobile !== undefined) business.widget.hideOnMobile = hideOnMobile;
  if (buttonText !== undefined) business.widget.buttonText = buttonText;
  if (allowedDomains !== undefined) {
    const clean = allowedDomains.map(normalizeDomain);
    const bad = allowedDomains.filter((d, i) => d.trim() && !clean[i]);
    if (bad.length) {
      throw new ApiError(422, `Revisa el dominio "${bad[0]}": escribe solo el dominio, por ejemplo misitio.com.`, {
        code: 'BAD_DOMAIN',
      });
    }
    business.widget.allowedDomains = [...new Set(clean.filter(Boolean))];
  }
  // La llave se crea la primera vez; regenerarla invalida los snippets anteriores.
  if (!business.widget.key || regenerateKey) business.widget.key = newKey();
  await business.save();

  if (enabled !== undefined && enabled !== prevEnabled) {
    void logAudit({
      businessId: req.businessId,
      userId: req.userId,
      action: 'widget.toggle',
      summary: enabled ? 'Activó el widget del sitio web.' : 'Desactivó el widget del sitio web.',
    });
  }
  res.json({ success: true, data: widgetView(business, planKey) });
});

/* ── Público (sitio del cliente / iframe) ───────────────────────────────── */

/**
 * Resuelve el negocio de una llave pública y verifica que el widget esté activo y
 * el plan lo incluya. Devuelve null si no aplica (las rutas responden 404 genérico
 * para no revelar si la llave existe).
 */
async function resolveWidget(key) {
  if (!KEY_RE.test(String(key || ''))) return null;
  const business = await Business.findOne({ 'widget.key': key });
  if (!business?.widget?.enabled) return null;
  const planKey = await getPlanKey(business._id);
  if (!PLAN_LIMITS[planKey]?.webWidget) return null;
  return business;
}

const notAvailable = () => new ApiError(404, 'Este chat no está disponible.', { code: 'WIDGET_UNAVAILABLE' });

/** GET /api/widget/public/:key — apariencia del widget (CORS abierto). */
export const publicConfig = asyncHandler(async (req, res) => {
  const business = await resolveWidget(req.params.key);
  if (!business) throw notAvailable();
  // Dominios permitidos: el snippet pide la config desde el sitio del cliente, y
  // el navegador manda su Origin (no falsificable desde una página). Si el sitio
  // no está en la lista, el botón ni se dibuja. `host` lo manda el iframe.
  const host = hostFromOrigin(req.get('origin')) || String(req.query.host || '');
  if (!hostAllowed(business, host)) throw notAvailable();
  const [bot, planKey] = await Promise.all([
    BotConfig.findOne({ business: business._id }).select('botName').lean(),
    getPlanKey(business._id),
  ]);
  const w = business.widget;
  res.set('Cache-Control', 'public, max-age=60');
  res.set('Vary', 'Origin');
  res.json({
    success: true,
    data: {
      businessName: business.name,
      botName: bot?.botName || 'Asistente',
      photo: business.photo || '',
      color: w.color || '#4f46e5',
      greeting: w.greeting || '',
      position: w.position || 'right',
      suggestions: w.suggestions || [],
      autoOpenSeconds: w.autoOpenSeconds || 0,
      requireContact: Boolean(w.requireContact),
      hideOnMobile: Boolean(w.hideOnMobile),
      buttonText: w.buttonText || '',
      // El visitante puede adjuntar foto o PDF solo si el plan lee archivos (Elite).
      allowFiles: Boolean(PLAN_LIMITS[planKey]?.visionInput),
    },
  });
});

/**
 * Mensajes visibles para el visitante (sin tokens, calificaciones ni metadatos).
 * `after` = cuántos ya tiene el iframe: solo se mandan los nuevos (las imágenes
 * del bot pueden pesar, no se reenvían en cada sondeo).
 */
function publicMessages(chat, after = 0) {
  const all = chat?.messages || [];
  const from = Number.isInteger(after) && after > 0 && after <= all.length ? after : 0;
  return all.slice(from).map((m) => ({
    role: m.role,
    content: m.content === '(imagen del cliente)' || /^\(documento del cliente: .*\)$/.test(m.content) ? '' : m.content,
    files: (m.files || []).map((f) => ({ name: f.name })),
    images: (m.images || []).filter((i) => /^https?:|^data:image\//.test(i.url || '')).map((i) => ({ label: i.label, url: i.url })),
    via: m.via,
    at: m.timestamp,
  }));
}

function findSessionChat(businessId, sessionId) {
  return ChatSimulation.findOne({ business: businessId, channel: 'web', customerId: sessionId }).sort({ updatedAt: -1 });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[\d\s().-]{7,20}$/;

export const widgetMessageSchema = z.object({
  sessionId: z.string().regex(SESSION_RE, 'Sesión no válida'),
  message: z.string().trim().max(1000).optional().default(''),
  // Foto o PDF del visitante (Elite).
  file: inboundFileSchema.optional(),
  after: z.number().int().min(0).optional().default(0),
  // Sitio donde está incrustado el chat (lo manda el iframe) para "dominios permitidos".
  host: z.string().max(253).optional().default(''),
  // Datos que pide el widget antes de chatear (si el negocio lo activó).
  contact: z
    .object({
      name: z.string().trim().min(2, 'Escribe tu nombre').max(60),
      value: z
        .string()
        .trim()
        .max(120)
        .refine((v) => EMAIL_RE.test(v) || PHONE_RE.test(v), 'Escribe un correo o un número de WhatsApp válido'),
    })
    .optional(),
}).refine((d) => d.message.length > 0 || d.file, { message: 'Escribe un mensaje', path: ['message'] });

/** Valida el archivo del visitante y lo convierte al formato de processMessage. */
async function parseVisitorFile(business, file) {
  if (!file) return {};
  const planKey = await getPlanKey(business._id);
  if (!PLAN_LIMITS[planKey]?.visionInput) {
    throw new ApiError(403, 'Este chat no acepta archivos.', { code: 'FILES_NOT_ALLOWED' });
  }
  return parseUploadedFile(file);
}

/** POST /api/widget/public/:key/message — el visitante escribe; responde el bot. */
export const publicMessage = asyncHandler(async (req, res) => {
  const business = await resolveWidget(req.params.key);
  if (!business) throw notAvailable();
  const { sessionId, message, after, host, contact, file } = req.body;
  if (!hostAllowed(business, host)) throw notAvailable();
  if (isBlocked(business, 'web', sessionId)) {
    throw new ApiError(403, 'No podemos atenderte por este medio.', { code: 'BLOCKED' });
  }
  const { image, document } = await parseVisitorFile(business, file);

  const existing = await findSessionChat(business._id, sessionId);
  // Captura de prospectos: la PRIMERA vez se piden nombre y contacto.
  if (business.widget.requireContact && !existing?.customerContact && !contact) {
    throw new ApiError(400, 'Déjanos tu nombre y un medio de contacto para empezar.', { code: 'CONTACT_REQUIRED' });
  }
  if (existing) {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const recent = existing.messages.filter((m) => m.role === 'user' && new Date(m.timestamp).getTime() > since).length;
    if (recent >= SESSION_DAILY_CAP) {
      throw new ApiError(429, 'Alcanzaste el límite de mensajes por hoy. Escríbenos más tarde.', { code: 'SESSION_CAP' });
    }
    if (file) {
      const files = existing.messages.filter(
        (m) => m.role === 'user' && new Date(m.timestamp).getTime() > since && (m.images?.length || m.files?.length)
      ).length;
      if (files >= SESSION_FILE_CAP) {
        throw new ApiError(429, 'Alcanzaste el límite de archivos por hoy. Escríbenos tu duda por aquí.', { code: 'FILE_CAP' });
      }
    }
  }

  try {
    const result = await processMessage({
      businessId: business._id,
      business,
      message,
      image,
      document,
      chatId: existing?._id,
      channel: 'web',
      customer: { id: sessionId, name: contact?.name || '' },
      source: 'web',
    });
    // Degradado (IA caída): no se persistió nada → el iframe muestra solo `reply`.
    const chat = result.chatId ? await ChatSimulation.findById(result.chatId) : null;
    if (chat) {
      let dirty = false;
      if (contact && !chat.customerContact) {
        chat.customerContact = contact.value;
        if (!chat.customerName) chat.customerName = contact.name;
        if (!chat.title || chat.title === message.slice(0, 40)) chat.title = contact.name;
        dirty = true;
      }
      // Sitio donde está el chat (para el enlace del aviso por correo).
      const site = normalizeDomain(host);
      if (site && !OWN_HOSTS.includes(site) && chat.webOrigin !== site) {
        chat.webOrigin = site;
        dirty = true;
      }
      chat.webLastSeenAt = new Date();
      if (dirty) await chat.save();
      else await ChatSimulation.updateOne({ _id: chat._id }, { $set: { webLastSeenAt: new Date() } }, { timestamps: false });
    }
    res.json({
      success: true,
      data: {
        reply: result.reply || null,
        paused: Boolean(result.paused), // una persona atiende: su respuesta llega por sondeo
        messages: chat ? publicMessages(chat, after) : null,
        total: chat ? chat.messages.length : null,
      },
    });
  } catch (err) {
    // Sin créditos: mensaje amable para el visitante (el dueño ya recibe su aviso).
    if (err.statusCode === 402) {
      logger.warn(`Widget: negocio ${business._id} sin créditos; mensaje no atendido.`);
      return res.json({
        success: true,
        data: {
          reply: 'En este momento no podemos responder por aquí. Por favor contáctanos por otro medio.',
          paused: false,
          messages: null,
          total: null,
        },
      });
    }
    throw err;
  }
});

/** GET /api/widget/public/:key/messages?sessionId= — hilo de la sesión (sondeo). */
export const publicThread = asyncHandler(async (req, res) => {
  const business = await resolveWidget(req.params.key);
  if (!business) throw notAvailable();
  if (!hostAllowed(business, req.query.host)) throw notAvailable();
  const sessionId = String(req.query.sessionId || '');
  if (!SESSION_RE.test(sessionId)) throw ApiError.badRequest('Sesión no válida');
  const after = Number.parseInt(req.query.after, 10) || 0;
  const chat = await findSessionChat(business._id, sessionId);
  // El visitante sigue con el chat abierto: si el equipo responde, lo verá aquí
  // (no hace falta avisarle por correo). Sin tocar updatedAt (orden de la bandeja).
  if (chat && (!chat.webLastSeenAt || Date.now() - chat.webLastSeenAt.getTime() > 30_000)) {
    await ChatSimulation.updateOne({ _id: chat._id }, { $set: { webLastSeenAt: new Date() } }, { timestamps: false });
  }
  res.json({
    success: true,
    data: {
      messages: publicMessages(chat, after),
      total: chat ? chat.messages.length : 0,
      // Ya dejó sus datos: el iframe no vuelve a pedirlos.
      hasContact: Boolean(chat?.customerContact),
    },
  });
});
