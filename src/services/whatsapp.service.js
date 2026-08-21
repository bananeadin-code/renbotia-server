import crypto from 'crypto';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

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

  const url = `${GRAPH}/${env.whatsapp.apiVersion}/${id}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to,
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
