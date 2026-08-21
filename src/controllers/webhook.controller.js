import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { Business } from '../models/Business.js';
import { ChatSimulation } from '../models/ChatSimulation.js';
import { processMessage } from '../services/simulator.service.js';
import { verifySignature, sendText } from '../services/whatsapp.service.js';

/**
 * Webhook de WhatsApp Cloud API (Meta).
 *
 *  GET  → verificación del webhook al configurarlo (hub.challenge).
 *  POST → recepción de mensajes entrantes. Respondemos 200 de inmediato y
 *         procesamos en segundo plano (Meta reintenta si no ve un 200 rápido).
 */

// Dedupe en memoria: Meta puede reintentar el mismo mensaje. Guardamos los ids
// recientes ya procesados para no responder (ni cobrar) dos veces. Acotado.
const processedIds = new Set();
function alreadyProcessed(id) {
  if (!id) return false;
  if (processedIds.has(id)) return true;
  processedIds.add(id);
  if (processedIds.size > 500) {
    // Poda simple: elimina el más viejo (orden de inserción).
    processedIds.delete(processedIds.values().next().value);
  }
  return false;
}

/** GET: Meta verifica el webhook comparando verify_token y devolviendo el challenge. */
export function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token && token === env.whatsapp.verifyToken) {
    logger.info('WhatsApp: webhook verificado por Meta.');
    return res.status(200).send(challenge);
  }
  logger.warn('WhatsApp: verificación de webhook rechazada (token no coincide).');
  return res.sendStatus(403);
}

/** POST: recibe eventos. Verifica firma, responde 200 y procesa en background. */
export function receiveWebhook(req, res) {
  // 1) Seguridad: la firma debe corresponder al App Secret sobre el body crudo.
  const signature = req.get('x-hub-signature-256');
  if (!verifySignature(req.rawBody, signature)) {
    logger.warn('WhatsApp: firma de webhook inválida; se descarta.');
    return res.sendStatus(401);
  }

  // 2) Responder YA para que Meta no reintente; procesar sin bloquear la respuesta.
  res.sendStatus(200);
  processInbound(req.body).catch((err) =>
    logger.error(`WhatsApp: error procesando webhook: ${err.message}`)
  );
}

/** Procesa el payload: por cada mensaje de texto, corre el bot y responde. */
async function processInbound(payload) {
  if (payload?.object !== 'whatsapp_business_account') return;

  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      // Ignoramos recibos de entrega/lectura (statuses) y campos que no sean mensajes.
      const messages = value.messages || [];
      if (!messages.length) continue;

      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      // Enrutar al negocio dueño de ese número.
      const business = await Business.findOne({ whatsappPhoneNumberId: phoneNumberId });
      if (!business) {
        logger.warn(`WhatsApp: mensaje para phone_number_id ${phoneNumberId} sin negocio asociado.`);
        continue;
      }

      const contact = (value.contacts || [])[0];
      const customerName = contact?.profile?.name || '';

      for (const msg of messages) {
        await handleMessage({ business, phoneNumberId, msg, customerName });
      }
    }
  }
}

async function handleMessage({ business, phoneNumberId, msg, customerName }) {
  if (alreadyProcessed(msg.id)) return;

  const from = msg.from; // wa_id del cliente (solo dígitos)
  let text = '';
  if (msg.type === 'text') {
    text = msg.text?.body || '';
  } else {
    // Tipos no soportados aún (imagen, audio, ubicación…): respondemos con un aviso
    // amable en vez de ignorar al cliente. No consume tokens del plan.
    await sendText({
      phoneNumberId,
      to: from,
      text: 'Por ahora solo puedo leer mensajes de texto. ¿Me lo escribes por aquí?',
    });
    return;
  }
  if (!text.trim()) return;

  // Continuar la conversación abierta de este cliente (si existe) para conservar
  // contexto y el modo de relevo (bot/manual).
  const existing = await ChatSimulation.findOne({
    business: business._id,
    channel: 'whatsapp',
    customerPhone: from,
  }).sort({ updatedAt: -1 });

  try {
    const result = await processMessage({
      businessId: business._id,
      business,
      message: text,
      chatId: existing?._id,
      channel: 'whatsapp',
      customer: { phone: from, name: customerName },
      source: 'whatsapp',
    });

    // En modo manual (una persona tomó el control) NO respondemos automáticamente:
    // el agente contestará desde la bandeja de Conversaciones.
    if (result?.paused) return;

    if (result?.reply) {
      await sendText({ phoneNumberId, to: from, text: result.reply });
    }
  } catch (err) {
    // Sin créditos (402): no respondemos con un error técnico al cliente real; se
    // registra y el dueño ya recibe aviso de saldo bajo por otro camino.
    if (err.statusCode === 402) {
      logger.warn(`WhatsApp: negocio ${business._id} sin créditos; mensaje no atendido.`);
      return;
    }
    logger.error(`WhatsApp: fallo al procesar mensaje de ${from}: ${err.message}`);
  }
}
