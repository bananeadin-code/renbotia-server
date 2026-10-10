import { env } from '../config/env.js';
import { isBlocked } from '../utils/blocklist.js';
import { logger } from '../utils/logger.js';
import { Business } from '../models/Business.js';
import { ChatSimulation } from '../models/ChatSimulation.js';
import { processMessage } from '../services/simulator.service.js';
import { verifySignature, sendText, sendImage, downloadMedia } from '../services/whatsapp.service.js';
import {
  sendMessengerText,
  sendMessengerImage,
  getMessengerProfileName,
  downloadMessengerImage,
  downloadMetaFile,
} from '../services/messenger.service.js';
import { isPdf, pdfPageCount, safeFileName, MAX_DOC_BYTES } from '../utils/document.js';
import { sendInstagramText, sendInstagramImage, getInstagramProfileName } from '../services/instagram.service.js';
import { isLinkCode, tryLinkOwner, ownerEntry, handleOwnerMessage } from '../services/ownerControl.service.js';

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

// Qué decirle al equipo en la bandeja cuando llega algo que el bot no procesa.
const UNSUPPORTED_LABEL = {
  audio: 'una nota de voz',
  voice: 'una nota de voz',
  video: 'un video',
  location: 'una ubicación',
  document: 'un documento',
  file: 'un archivo',
  contacts: 'un contacto',
};
// Tipos que se ignoran en silencio (no ameritan respuesta).
const SILENT_TYPES = new Set(['reaction', 'sticker', 'system', 'unsupported', 'ephemeral', 'request_welcome']);
const UNSUPPORTED_REPLY = 'Por ahora no puedo escuchar audios ni abrir ese tipo de archivo. ¿Me lo escribes por aquí?';

/**
 * Llegó algo que el bot no procesa (audio, video, ubicación…). Si una persona
 * atiende la conversación (modo manual), NO se le contesta automáticamente al
 * cliente: se deja constancia en la bandeja para el equipo. Si atiende el bot,
 * se le pide amablemente que lo escriba. Devuelve true si debe enviarse el aviso.
 */
async function noteUnsupported({ business, channel, match, kind }) {
  const chat = await ChatSimulation.findOne({ business: business._id, channel, ...match }).sort({ updatedAt: -1 });
  if (chat && chat.handoffMode === 'manual') {
    chat.messages.push({
      role: 'user',
      content: `(El cliente envió ${UNSUPPORTED_LABEL[kind] || 'un archivo'} que no se puede mostrar aquí.)`,
      timestamp: new Date(),
    });
    await chat.save().catch(() => {});
    return false;
  }
  return true;
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

/**
 * Despacha el webhook según su origen. La MISMA URL recibe eventos de WhatsApp y
 * de Páginas de Facebook (Messenger) e Instagram; se distinguen por `payload.object`.
 */
async function processInbound(payload) {
  if (payload?.object === 'page') return processMessengerInbound(payload);
  if (payload?.object === 'instagram') return processInstagramInbound(payload);
  return processWhatsAppInbound(payload);
}

/** WhatsApp: por cada mensaje de texto/imagen, corre el bot y responde. */
async function processWhatsAppInbound(payload) {
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
  // Contacto bloqueado por el negocio: se ignora (sin guardar ni gastar créditos).
  if (isBlocked(business, 'whatsapp', from) && !ownerEntry(business, from)) return;

  // Control del dueño: código de vinculación "RB-XXXXXXXX" o mensaje de un número
  // de dueño ya vinculado. Nunca pasan al bot de clientes (salvo "modo cliente").
  try {
    if (msg.type === 'text' && isLinkCode(msg.text?.body)) {
      await tryLinkOwner({ business, waId: from, text: msg.text.body, phoneNumberId });
      return;
    }
    if (ownerEntry(business, from)) {
      const handled = await handleOwnerMessage({ business, waId: from, msg, phoneNumberId });
      if (handled) return;
    }
  } catch (err) {
    logger.error(`Dueño por WhatsApp: ${err.message}`);
    return;
  }
  let text = '';
  let image = null;
  let document = null;
  if (SILENT_TYPES.has(msg.type)) return; // reacciones, stickers, avisos del sistema
  if (msg.type === 'text') {
    text = msg.text?.body || '';
  } else if (msg.type === 'button') {
    // Botón de respuesta rápida de una plantilla (p. ej. el seguimiento).
    text = msg.button?.text || msg.button?.payload || '';
  } else if (msg.type === 'interactive') {
    text = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
  } else if (msg.type === 'document' && /pdf/i.test(msg.document?.mime_type || '')) {
    // PDF del cliente (cotización, comprobante…): el bot lo lee en Elite.
    const media = await downloadMedia(msg.document?.id);
    const buf = media.ok ? Buffer.from(media.base64, 'base64') : null;
    if (!buf || !isPdf(buf) || buf.length > MAX_DOC_BYTES) {
      await sendText({
        phoneNumberId,
        to: from,
        text: 'No pude abrir ese documento (máximo 5 MB, en PDF). ¿Puedes reenviarlo o escribirme el detalle por aquí?',
      });
      return;
    }
    document = {
      mediaType: 'application/pdf',
      data: media.base64,
      name: safeFileName(msg.document?.filename),
      pages: pdfPageCount(buf),
    };
    text = msg.document?.caption || '';
  } else if (msg.type === 'image') {
    // El cliente mandó una imagen: la descargamos y se la pasamos al bot para que
    // la interprete (la visión solo se usa en Elite; lo decide processMessage).
    const media = await downloadMedia(msg.image?.id);
    if (media.ok && /^image\//.test(media.mime)) {
      image = { mediaType: media.mime, data: media.base64 };
      text = msg.image?.caption || '';
    } else {
      await sendText({
        phoneNumberId,
        to: from,
        text: 'No pude abrir esa imagen. ¿Puedes reenviarla o escribirme el detalle por aquí?',
      });
      return;
    }
  } else {
    // Otros tipos (audio, video, ubicación…): aviso amable (no consume tokens),
    // salvo que una persona esté atendiendo: entonces solo se anota en la bandeja.
    if (await noteUnsupported({ business, channel: 'whatsapp', match: { customerPhone: from }, kind: msg.type })) {
      await sendText({ phoneNumberId, to: from, text: UNSUPPORTED_REPLY });
    }
    return;
  }
  if (!text.trim() && !image && !document) return;

  // Continuar la conversación abierta de este cliente (si existe) para conservar
  // contexto y el modo de relevo (bot/manual).
  // Solo su _id: processMessage la carga completa (antes se cargaba dos veces).
  const existing = await ChatSimulation.findOne({
    business: business._id,
    channel: 'whatsapp',
    customerPhone: from,
  })
    .sort({ updatedAt: -1 })
    .select('_id')
    .lean();

  try {
    const result = await processMessage({
      businessId: business._id,
      business,
      message: text,
      image,
      document,
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
    // Imágenes que el bot decidió enviar (Elite): tras el texto, en orden.
    // OJO: processMessage devuelve `sentImages` (no `images`). Se registra el
    // fallo por imagen para no perderlo en silencio.
    for (const image of result?.sentImages || []) {
      const r = await sendImage({ phoneNumberId, to: from, image });
      if (!r?.ok) {
        logger.error(`WhatsApp: no se pudo enviar la imagen "${image?.label}": ${r?.error}`);
      }
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

/* ── Facebook Messenger e Instagram DMs ───────────────────────────────────────
   Mismo webhook, payload entry[].messaging[] con sender.id (PSID en Messenger,
   IGSID en Instagram) y message.text/attachments. Messenger se enruta por el id
   de la Página (entry.id); Instagram por el id de la cuenta de IG (entry.id). Ambos
   responden con el token de la Página por /me/messages. */

// Adaptadores por canal: cómo enviar, cómo obtener el nombre del cliente.
const DM_CHANNELS = {
  facebook: {
    label: 'Messenger',
    sendText: sendMessengerText,
    sendImage: sendMessengerImage,
    getName: getMessengerProfileName,
  },
  instagram: {
    label: 'Instagram',
    sendText: sendInstagramText,
    sendImage: sendInstagramImage,
    getName: getInstagramProfileName,
  },
};

async function processMessengerInbound(payload) {
  for (const entry of payload.entry || []) {
    const pageId = entry.id;
    if (!pageId) continue;
    logger.info(`Messenger: webhook recibido para la página ${pageId} (${(entry.messaging || []).length} evento/s).`);
    // El token de Página es select:false; lo pedimos explícito para poder responder.
    const business = await Business.findOne({ facebookPageId: pageId }).select('+facebookPageToken');
    if (!business) {
      logger.warn(`Messenger: evento para la página ${pageId} sin negocio asociado.`);
      continue;
    }
    for (const event of entry.messaging || []) {
      await handleDmMessage({ business, event, channel: 'facebook', pageToken: business.facebookPageToken });
    }
  }
}

async function processInstagramInbound(payload) {
  for (const entry of payload.entry || []) {
    const igId = entry.id;
    if (!igId) continue;
    logger.info(`Instagram: webhook recibido para la cuenta ${igId} (${(entry.messaging || []).length} evento/s).`);
    const business = await Business.findOne({ instagramAccountId: igId }).select('+instagramPageToken');
    if (!business) {
      logger.warn(`Instagram: evento para la cuenta ${igId} sin negocio asociado.`);
      continue;
    }
    for (const event of entry.messaging || []) {
      // En Instagram, un mensaje que la propia cuenta envía llega con sender = la cuenta.
      if (event.sender?.id === igId) continue;
      await handleDmMessage({ business, event, channel: 'instagram', pageToken: business.instagramPageToken });
    }
  }
}

// Texto de una pregunta inicial tocada: Meta manda su título; si no viniera, se
// recupera del payload (ICEBREAKER_n) con las preguntas guardadas del canal.
function postbackText(business, channel, postback) {
  if (!postback) return '';
  if (postback.title) return postback.title;
  const n = /^ICEBREAKER_(\d+)$/.exec(postback.payload || '')?.[1];
  const list = business.channelSettings?.[channel]?.iceBreakers || [];
  return n ? list[Number(n) - 1] || '' : '';
}

async function handleDmMessage({ business, event, channel, pageToken }) {
  const ch = DM_CHANNELS[channel];
  const pbText = postbackText(business, channel, event.postback);
  if (event.postback) logger.info(`${ch.label}: pregunta inicial tocada ("${pbText || event.postback.payload || '?'}").`);
  // Al tocar una pregunta inicial (ice breaker) llega un postback con su texto:
  // se atiende como si el cliente la hubiera escrito.
  const msg =
    event.message ||
    (pbText
      ? { mid: event.postback.mid || `pb_${event.sender?.id}_${event.timestamp}`, text: pbText }
      : null);
  // Ignorar ecos (lo que envía la propia cuenta), mensajes borrados y eventos sin
  // mensaje (entregas, lecturas, reacciones, postbacks). Dedupe por mid.
  if (!msg || msg.is_echo || msg.is_deleted || msg.is_unsupported) return;
  if (alreadyProcessed(msg.mid)) return;

  const senderId = event.sender?.id; // PSID / IGSID del cliente
  if (!senderId) return;
  if (isBlocked(business, channel, senderId)) return; // contacto bloqueado

  let text = (msg.text || '').trim();
  let image = null;
  let document = null;
  if (!text) {
    const fileAtt = (msg.attachments || []).find((a) => a.type === 'file' && a.payload?.url);
    // Imagen del cliente: se descarga y se pasa al bot (la visión solo se usa en
    // Elite; lo decide processMessage). Otros adjuntos (audio, stickers…): aviso.
    const att = (msg.attachments || []).find((a) => a.type === 'image' && a.payload?.url && !a.payload?.sticker_id);
    if (!att && fileAtt) {
      // Archivo: solo PDF (verificado por su firma, no por el nombre).
      const file = await downloadMetaFile(fileAtt.payload.url, MAX_DOC_BYTES);
      if (file.ok && isPdf(file.buf)) {
        document = {
          mediaType: 'application/pdf',
          data: file.buf.toString('base64'),
          name: safeFileName(fileAtt.payload?.name || fileAtt.name),
          pages: pdfPageCount(file.buf),
        };
      } else if (await noteUnsupported({ business, channel, match: { customerId: senderId }, kind: 'file' })) {
        await ch.sendText({ pageToken, recipientId: senderId, text: UNSUPPORTED_REPLY });
        return;
      } else {
        return;
      }
    } else if (att) {
      const media = await downloadMessengerImage(att.payload.url);
      if (media.ok) {
        image = { mediaType: media.mime, data: media.base64 };
      } else {
        await ch.sendText({
          pageToken,
          recipientId: senderId,
          text: 'No pude abrir esa imagen. ¿Puedes reenviarla o escribirme el detalle por aquí?',
        });
        return;
      }
    } else {
      // Audio, video, ubicación… (los stickers llegan como imagen con sticker_id
      // y se ignoran en silencio).
      const kinds = (msg.attachments || []).map((a) => a.type).filter((t) => t !== 'image');
      if (kinds.length && (await noteUnsupported({ business, channel, match: { customerId: senderId }, kind: kinds[0] }))) {
        await ch.sendText({ pageToken, recipientId: senderId, text: UNSUPPORTED_REPLY });
      }
      return;
    }
  }

  // Continuar la conversación abierta de este cliente (por PSID/IGSID).
  const existing = await ChatSimulation.findOne({
    business: business._id,
    channel,
    customerId: senderId,
  })
    .sort({ updatedAt: -1 })
    .select('_id customerName')
    .lean();

  // Nombre del cliente: solo si aún no lo tenemos, para no consultar a Meta en
  // cada mensaje.
  let customerName = existing?.customerName || '';
  if (!customerName) {
    customerName = await ch.getName(senderId, pageToken);
    if (existing && customerName) {
      existing.customerName = customerName;
      await existing.save().catch(() => {});
    }
  }

  try {
    const result = await processMessage({
      businessId: business._id,
      business,
      message: text,
      image,
      document,
      chatId: existing?._id,
      channel,
      customer: { id: senderId, name: customerName },
      source: channel,
    });

    if (result?.paused) return; // modo manual: responde una persona desde la bandeja
    if (result?.reply) {
      const sent = await ch.sendText({ pageToken, recipientId: senderId, text: result.reply });
      if (sent.ok) logger.info(`${ch.label}: respuesta enviada a ${senderId}.`);
    }
    // Imágenes que el bot decidió enviar (Elite): tras el texto, en orden.
    for (const img of result?.sentImages || []) {
      const r = await ch.sendImage({ pageToken, recipientId: senderId, image: img });
      if (!r?.ok) logger.error(`${ch.label}: no se pudo enviar la imagen "${img?.label}": ${r?.error}`);
    }
  } catch (err) {
    if (err.statusCode === 402) {
      logger.warn(`${ch.label}: negocio ${business._id} sin créditos; mensaje no atendido.`);
      return;
    }
    logger.error(`${ch.label}: fallo al procesar mensaje de ${senderId}: ${err.message}`);
  }
}
