import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Adaptador de Facebook Messenger (Meta Graph API). Separado de WhatsApp: aquí el
 * token es POR PÁGINA (page access token), no un token central. Envía respuestas
 * del bot a un cliente identificado por su PSID.
 *
 * Nota: la app de Meta es la MISMA que WhatsApp, por eso el App Secret (firma del
 * webhook) y la versión de la Graph API se reutilizan de env.whatsapp.
 */
const GRAPH = () => `https://graph.facebook.com/${env.whatsapp.apiVersion || 'v21.0'}`;

/**
 * Envía un mensaje de texto a un cliente de Messenger.
 * @param {{ pageToken:string, recipientId:string, text:string }} p
 * @returns {Promise<{ ok:boolean, id?:string, status?:number, error?:string }>}
 */
export async function sendMessengerText({ pageToken, recipientId, text }) {
  if (!pageToken || !recipientId) {
    logger.warn('Messenger: envío omitido (sin token de página o destinatario).');
    return { ok: false, error: 'missing_params' };
  }
  try {
    const res = await fetch(`${GRAPH()}/me/messages?access_token=${encodeURIComponent(pageToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientId },
        messaging_type: 'RESPONSE', // respuesta a un mensaje del usuario (ventana 24h)
        message: { text },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      logger.warn(`Messenger: envío ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
      return { ok: false, status: res.status, error: data?.error?.message };
    }
    return { ok: true, id: data.message_id };
  } catch (err) {
    logger.warn(`Messenger: error de envío: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Datos públicos de una Página (nombre) a partir de su token. Para mostrar en el
 * panel al conectar. Fail-soft.
 */
export async function getPageInfo(pageId, pageToken) {
  try {
    const res = await fetch(
      `${GRAPH()}/${pageId}?fields=name&access_token=${encodeURIComponent(pageToken)}`
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false };
    return { ok: true, name: data.name || '' };
  } catch {
    return { ok: false };
  }
}

/**
 * Suscribe la app a los eventos de mensajería de la Página (necesario para recibir
 * los mensajes en el webhook). Se llama al conectar la Página.
 */
export async function subscribePageToApp(pageId, pageToken) {
  try {
    const res = await fetch(`${GRAPH()}/${pageId}/subscribed_apps?access_token=${encodeURIComponent(pageToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscribed_fields: 'messages,messaging_postbacks' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      logger.warn(`Messenger: no se pudo suscribir la página ${pageId}: ${JSON.stringify(data).slice(0, 200)}`);
      return { ok: false, error: data?.error?.message };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
