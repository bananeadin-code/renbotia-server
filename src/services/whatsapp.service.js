import crypto from 'crypto';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { toWhatsAppNumber } from '../utils/phone.js';

/**
 * Integración con WhatsApp Cloud API (Meta / Graph API).
 *
 * Responsabilidades:
 *  - Verificar la firma HMAC de los webhooks entrantes (seguridad).
 *  - Enviar mensajes de texto salientes (respuestas del bot / del agente).
 *
 * Todo es "best effort": si falta configuración (token/appSecret), se registra y
 * se omite el envío, sin tumbar el proceso. El producto sigue vivo en simulador.
 */

const GRAPH = 'https://graph.facebook.com';

/** ¿Hay credenciales suficientes para ENVIAR por la Cloud API? */
export function isConfigured() {
  return Boolean(env.whatsapp.token);
}

/**
 * Verifica la firma X-Hub-Signature-256 del webhook contra el App Secret.
 * Meta firma los BYTES EXACTOS del body (por eso guardamos req.rawBody).
 *
 * @param {Buffer} rawBody  cuerpo crudo de la petición
 * @param {string} signatureHeader  valor del header 'x-hub-signature-256' ("sha256=…")
 * @returns {boolean} true si la firma es válida (o si no hay appSecret configurado)
 */
export function verifySignature(rawBody, signatureHeader) {
  // Sin App Secret no podemos verificar (entorno de desarrollo): dejamos pasar,
  // pero avisamos. En producción SIEMPRE debe estar configurado.
  if (!env.whatsapp.appSecret) {
    logger.warn('WhatsApp: WHATSAPP_APP_SECRET no configurado; se omite verificación de firma.');
    return true;
  }
  if (!signatureHeader || !rawBody) return false;

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', env.whatsapp.appSecret).update(rawBody).digest('hex');

  // Comparación en tiempo constante para evitar ataques de temporización.
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Envía un mensaje de texto por la Cloud API.
 *
 * @param {object} p
 * @param {string} p.phoneNumberId  id del número emisor (el del negocio)
 * @param {string} p.to             destinatario en formato wa_id / E.164 sin '+'
 * @param {string} p.text           cuerpo del mensaje
 * @returns {Promise<{ ok: boolean, id?: string, error?: string }>}
 */
export async function sendText({ phoneNumberId, to, text }) {
  const id = phoneNumberId || env.whatsapp.phoneNumberId;
  if (!isConfigured() || !id) {
    logger.warn('WhatsApp: envío omitido (sin token o sin phoneNumberId).');
    return { ok: false, error: 'not_configured' };
  }

  // México entrega el wa_id con un "1" extra (521…); para responder hay que
  // enviarlo sin ese 1 (52…) o Meta rechaza el envío. Se normaliza aquí.
  const recipient = toWhatsAppNumber(to);
  const url = `${GRAPH}/${env.whatsapp.apiVersion}/${id}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to: recipient,
    type: 'text',
    text: { preview_url: false, body: text.slice(0, 4096) },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.whatsapp.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      logger.error(`WhatsApp: fallo al enviar (${res.status}): ${JSON.stringify(data?.error || data)}`);
      return { ok: false, error: data?.error?.message || `HTTP ${res.status}` };
    }
    return { ok: true, id: data?.messages?.[0]?.id };
  } catch (err) {
    logger.error(`WhatsApp: error de red al enviar: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/** Extensión de archivo tentativa a partir del tipo MIME (para el upload). */
function extFromMime(mime) {
  const map = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
  return map[mime] || 'jpg';
}

/**
 * Sube una imagen (data URI base64) a la Cloud API y devuelve su media id.
 * La Graph API no acepta base64 en el mensaje: primero se sube a /{id}/media.
 * @returns {Promise<{ ok: boolean, id?: string, error?: string }>}
 */
async function uploadMedia(phoneNumberId, dataUri) {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUri);
  if (!m) return { ok: false, error: 'data URI inválido' };
  const mime = m[1];
  const buffer = Buffer.from(m[2], 'base64');

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([buffer], { type: mime }), `imagen.${extFromMime(mime)}`);

  const url = `${GRAPH}/${env.whatsapp.apiVersion}/${phoneNumberId}/media`;
  try {
    // Sin 'Content-Type' manual: fetch pone el boundary del multipart.
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.whatsapp.token}` },
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.id) {
      logger.error(`WhatsApp: fallo al subir media (${res.status}): ${JSON.stringify(data?.error || data)}`);
      return { ok: false, error: data?.error?.message || `HTTP ${res.status}` };
    }
    return { ok: true, id: data.id };
  } catch (err) {
    logger.error(`WhatsApp: error de red al subir media: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Envía una imagen del negocio por la Cloud API.
 * - url http(s): se manda por `link` (Meta la descarga).
 * - data URI base64: se sube primero a /media y se manda por `id`.
 *
 * @param {object} p
 * @param {string} p.phoneNumberId  id del número emisor (el del negocio)
 * @param {string} p.to             destinatario (wa_id / E.164 sin '+')
 * @param {{label?: string, url: string}} p.image  imagen a enviar
 * @param {string} [p.caption]      texto opcional bajo la imagen
 */
export async function sendImage({ phoneNumberId, to, image, caption }) {
  const id = phoneNumberId || env.whatsapp.phoneNumberId;
  if (!isConfigured() || !id) {
    logger.warn('WhatsApp: envío de imagen omitido (sin token o sin phoneNumberId).');
    return { ok: false, error: 'not_configured' };
  }
  const src = image?.url?.trim();
  if (!src) return { ok: false, error: 'imagen sin url' };

  let media;
  if (/^https?:\/\//i.test(src)) {
    media = { link: src };
  } else if (src.startsWith('data:')) {
    const up = await uploadMedia(id, src);
    if (!up.ok) return up;
    media = { id: up.id };
  } else {
    return { ok: false, error: 'formato de imagen no soportado' };
  }
  if (caption) media.caption = caption.slice(0, 1024);

  const url = `${GRAPH}/${env.whatsapp.apiVersion}/${id}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to: toWhatsAppNumber(to),
    type: 'image',
    image: media,
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.whatsapp.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      logger.error(`WhatsApp: fallo al enviar imagen (${res.status}): ${JSON.stringify(data?.error || data)}`);
      return { ok: false, error: data?.error?.message || `HTTP ${res.status}` };
    }
    return { ok: true, id: data?.messages?.[0]?.id };
  } catch (err) {
    logger.error(`WhatsApp: error de red al enviar imagen: ${err.message}`);
    return { ok: false, error: err.message };
  }
}
