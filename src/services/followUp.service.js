import { BotConfig } from '../models/BotConfig.js';
import { Business } from '../models/Business.js';
import { Subscription } from '../models/Subscription.js';
import { ChatSimulation } from '../models/ChatSimulation.js';
import { UsageLog } from '../models/UsageLog.js';
import { PLAN_LIMITS, MODEL_BY_PLAN } from '../config/constants.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { buildSystemPrompt } from './promptBuilder.service.js';
import { generateReply } from './claude.service.js';
import { applyLazyReset, hasBalance, deductTokens } from './token.service.js';
import { sanitizeBotConfigForPlan } from '../utils/planGating.js';
import { sendText } from './whatsapp.service.js';
import { sendMessengerText } from './messenger.service.js';
import { sendInstagramText } from './instagram.service.js';

/**
 * Seguimiento automático (Pro/Elite).
 *
 * Si el cliente deja de responder después de la última respuesta del BOT, se le
 * escribe UNA vez pasado `delayHours`, siempre DENTRO de la ventana de 24 h de
 * Meta (texto libre, sin plantilla ni costo extra de Meta). Canales: WhatsApp,
 * Messenger e Instagram. No se manda si:
 * la conversación está en modo manual, pide atención humana, el último mensaje
 * fue de una persona, ya se mandó un seguimiento en este silencio, o (modo IA)
 * el bot juzga que la conversación ya cerró de forma natural.
 */

const CHANNELS = ['whatsapp', 'facebook', 'instagram'];
const HOUR = 60 * 60 * 1000;
const WINDOW_MS = 24 * HOUR;
// Margen antes de que cierre la ventana: no arriesgar un envío que Meta rechace.
const WINDOW_MARGIN_MS = 20 * 60 * 1000;
const MAX_PER_BUSINESS_PER_RUN = 25;

const FOLLOWUP_TASK = `

# TAREA ESPECIAL: MENSAJE DE SEGUIMIENTO
El cliente dejó de responder después de tu último mensaje. Escribe UN mensaje breve
(máximo 2 frases) para retomar la conversación con amabilidad: por ejemplo, pregunta
si le quedó alguna duda, si quiere avanzar (agendar, cotizar, pedir) o recuérdale el
tema pendiente. Sin presionar, sin repetir información que ya diste, sin inventar
promociones ni descuentos. Mismo idioma y tono de la conversación.
Responde EXACTAMENTE: SKIP solo si el cliente CERRÓ la conversación de forma explícita
(se despidió, dijo que no le interesa, o ya concretó lo que buscaba y agradeció).`

function lastInboundAt(chat) {
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    if (chat.messages[i].role === 'user') return new Date(chat.messages[i].timestamp).getTime();
  }
  return null;
}

/** ¿Este chat toca seguimiento ahora? (lógica pura, sin I/O) */
export function isFollowUpDue(chat, delayMs, now = Date.now()) {
  if (!CHANNELS.includes(chat.channel)) return false;
  if (chat.handoffMode !== 'bot' || chat.needsAttention) return false;
  const last = chat.messages[chat.messages.length - 1];
  if (!last || last.role !== 'assistant' || last.via !== 'bot' || last.followUp) return false;
  const inbound = lastInboundAt(chat);
  if (!inbound) return false;
  // Un solo seguimiento por silencio: si ya hubo uno después del último mensaje
  // del cliente, no se repite.
  if (chat.followUpAt && new Date(chat.followUpAt).getTime() >= inbound) return false;
  if (now - new Date(last.timestamp).getTime() < delayMs) return false;
  return now < inbound + WINDOW_MS - WINDOW_MARGIN_MS;
}

async function composeFollowUp({ config, business, chat, planKey }) {
  if (config.followUp.mode === 'custom') return { text: config.followUp.message.trim(), usage: null };

  const safe = sanitizeBotConfigForPlan(config.toObject(), planKey);
  const system = buildSystemPrompt(safe, business) + FOLLOWUP_TASK;
  const history = chat.messages.slice(-20).map((m) => ({ role: m.role, content: m.content }));
  // Claude necesita terminar en un turno del usuario: marcador del silencio.
  const messages = [...history, { role: 'user', content: '(El cliente no ha respondido desde tu último mensaje.)' }];
  const model = MODEL_BY_PLAN[planKey] || env.anthropic.model;
  const r = await generateReply({ system, messages, model });
  const text = (r.text || '').trim();
  if (!text || /^SKIP\b/i.test(text) || text === '(sin respuesta)') return { text: null, usage: { ...r, model } };
  return { text, usage: { ...r, model } };
}

async function deliver({ business, chat, text }) {
  if (chat.channel === 'whatsapp') {
    return sendText({ phoneNumberId: business.whatsappPhoneNumberId, to: chat.customerPhone, text });
  }
  if (chat.channel === 'instagram') {
    return sendInstagramText({ pageToken: business.instagramPageToken, recipientId: chat.customerId, text });
  }
  return sendMessengerText({ pageToken: business.facebookPageToken, recipientId: chat.customerId, text });
}

async function runForBusiness(config) {
  const businessId = config.business;
  const subscription = await Subscription.findOne({ business: businessId }).populate('plan');
  if (!subscription) return 0;
  await applyLazyReset(subscription);
  const planKey = subscription.plan?.key || 'free';
  if (!PLAN_LIMITS[planKey]?.followUp) return 0;

  const business = await Business.findById(businessId).select('+facebookPageToken +instagramPageToken');
  if (!business) return 0;

  const delayMs = Math.min(20, Math.max(1, config.followUp.delayHours || 4)) * HOUR;
  const now = Date.now();
  const candidates = await ChatSimulation.find({
    business: businessId,
    channel: { $in: CHANNELS },
    handoffMode: 'bot',
    needsAttention: { $ne: true },
    updatedAt: { $gte: new Date(now - WINDOW_MS), $lte: new Date(now - delayMs) },
  })
    .sort({ updatedAt: 1 })
    .limit(100);

  let sent = 0;
  for (const chat of candidates) {
    if (sent >= MAX_PER_BUSINESS_PER_RUN) break;
    if (!isFollowUpDue(chat, delayMs, now)) continue;
    if (chat.channel === 'whatsapp' && !business.whatsappPhoneNumberId) continue;
    if (chat.channel === 'facebook' && !business.facebookPageToken) continue;
    if (chat.channel === 'instagram' && !business.instagramPageToken) continue;
    if (config.followUp.mode === 'ai' && !hasBalance(subscription, 1)) break;

    // Reclamo atómico: si otra instancia ya lo tomó, se salta. No toca updatedAt
    // (la bandeja ordena por actividad real).
    const claim = await ChatSimulation.updateOne(
      { _id: chat._id, followUpAt: chat.followUpAt ?? null },
      { $set: { followUpAt: new Date() } },
      { timestamps: false }
    );
    if (!claim.modifiedCount) continue;

    try {
      const { text, usage } = await composeFollowUp({ config, business, chat, planKey });
      if (usage) {
        await deductTokens(subscription, usage.billableTokens ?? usage.totalTokens);
        await UsageLog.create({
          business: businessId,
          date: new Date(),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
          totalTokens: usage.totalTokens,
          model: usage.model,
          source: 'followup',
        });
      }
      if (!text) {
        // El bot juzgó que la conversación ya cerró (queda reclamado: no se reintenta).
        logger.info(`Seguimiento: omitido en chat ${chat._id} (conversación cerrada).`);
        continue;
      }

      const result = await deliver({ business, chat, text });
      if (!result?.ok) {
        logger.warn(`Seguimiento: no se entregó en ${chat.channel} (chat ${chat._id}): ${result?.error || ''}`);
        continue;
      }
      await ChatSimulation.updateOne(
        { _id: chat._id },
        { $push: { messages: { role: 'assistant', content: text, via: 'bot', followUp: true, timestamp: new Date() } } }
      );
      sent++;
    } catch (err) {
      logger.warn(`Seguimiento: fallo en chat ${chat._id}: ${err.message}`);
    }
  }
  return sent;
}

let running = false;

/** Una pasada por todos los negocios con seguimiento activo. Reentrante-segura. */
export async function runFollowUps() {
  if (running) return { skipped: true };
  running = true;
  let total = 0;
  try {
    const configs = await BotConfig.find({ 'followUp.enabled': true });
    for (const config of configs) {
      try {
        total += await runForBusiness(config);
      } catch (err) {
        logger.warn(`Seguimiento: negocio ${config.business}: ${err.message}`);
      }
    }
    if (total) logger.info(`Seguimiento automático: ${total} mensaje(s) enviados.`);
    return { sent: total };
  } finally {
    running = false;
  }
}

/** Programa la pasada periódica dentro del proceso del servidor. */
export function startFollowUpScheduler() {
  if (process.env.FOLLOWUP_ENABLED === 'false') {
    logger.info('Seguimiento automático: programador desactivado (FOLLOWUP_ENABLED=false).');
    return;
  }
  const minutes = Math.max(5, Number(process.env.FOLLOWUP_INTERVAL_MIN) || 10);
  const timer = setInterval(() => {
    runFollowUps().catch((err) => logger.warn(`Seguimiento: ${err.message}`));
  }, minutes * 60 * 1000);
  timer.unref?.();
  logger.info(`Seguimiento automático: revisión cada ${minutes} min.`);
}
