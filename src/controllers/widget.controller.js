import crypto from 'node:crypto';
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
  };
}

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
  const prevEnabled = Boolean(business.widget?.enabled);
  if (enabled !== undefined) business.widget.enabled = enabled;
  if (color !== undefined) business.widget.color = color;
  if (greeting !== undefined) business.widget.greeting = greeting.trim();
  if (position !== undefined) business.widget.position = position;
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
  const bot = await BotConfig.findOne({ business: business._id }).select('botName').lean();
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    success: true,
    data: {
      businessName: business.name,
      botName: bot?.botName || 'Asistente',
      photo: business.photo || '',
      color: business.widget.color || '#4f46e5',
      greeting: business.widget.greeting || '',
      position: business.widget.position || 'right',
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
    content: m.content === '(imagen del cliente)' ? '' : m.content,
    images: (m.images || []).filter((i) => /^https?:|^data:image\//.test(i.url || '')).map((i) => ({ label: i.label, url: i.url })),
    via: m.via,
    at: m.timestamp,
  }));
}

function findSessionChat(businessId, sessionId) {
  return ChatSimulation.findOne({ business: businessId, channel: 'web', customerId: sessionId }).sort({ updatedAt: -1 });
}

export const widgetMessageSchema = z.object({
  sessionId: z.string().regex(SESSION_RE, 'Sesión no válida'),
  message: z.string().trim().min(1, 'Escribe un mensaje').max(1000),
  after: z.number().int().min(0).optional().default(0),
});

/** POST /api/widget/public/:key/message — el visitante escribe; responde el bot. */
export const publicMessage = asyncHandler(async (req, res) => {
  const business = await resolveWidget(req.params.key);
  if (!business) throw notAvailable();
  const { sessionId, message, after } = req.body;

  const existing = await findSessionChat(business._id, sessionId);
  if (existing) {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const recent = existing.messages.filter((m) => m.role === 'user' && new Date(m.timestamp).getTime() > since).length;
    if (recent >= SESSION_DAILY_CAP) {
      throw new ApiError(429, 'Alcanzaste el límite de mensajes por hoy. Escríbenos más tarde.', { code: 'SESSION_CAP' });
    }
  }

  try {
    const result = await processMessage({
      businessId: business._id,
      business,
      message,
      chatId: existing?._id,
      channel: 'web',
      customer: { id: sessionId, name: '' },
      source: 'web',
    });
    // Degradado (IA caída): no se persistió nada → el iframe muestra solo `reply`.
    const chat = result.chatId ? await ChatSimulation.findById(result.chatId) : null;
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
  const sessionId = String(req.query.sessionId || '');
  if (!SESSION_RE.test(sessionId)) throw ApiError.badRequest('Sesión no válida');
  const after = Number.parseInt(req.query.after, 10) || 0;
  const chat = await findSessionChat(business._id, sessionId);
  res.json({
    success: true,
    data: { messages: publicMessages(chat, after), total: chat ? chat.messages.length : 0 },
  });
});
