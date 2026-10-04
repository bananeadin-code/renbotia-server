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
 * Cambia un token de usuario corto por uno de LARGA duración (~60 días). Los
 * tokens de Página que se obtienen con un token largo NO expiran, por eso se hace
 * antes de listar las Páginas. Si falla, se devuelve el token original.
 */
export async function toLongLivedUserToken(userToken) {
  try {
    const url = new URL(`${GRAPH()}/oauth/access_token`);
    url.searchParams.set('grant_type', 'fb_exchange_token');
    url.searchParams.set('client_id', env.whatsapp.appId);
    url.searchParams.set('client_secret', env.whatsapp.appSecret);
    url.searchParams.set('fb_exchange_token', userToken);
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) return userToken;
    return data.access_token;
  } catch {
    return userToken;
  }
}

/**
 * Páginas que el usuario concedió en el Facebook Login, con su token de Página.
 * @returns {Promise<{ ok:boolean, pages?: Array<{id:string,name:string,access_token:string}>, error?:string }>}
 */
export async function listUserPages(userToken) {
  try {
    const res = await fetch(
      `${GRAPH()}/me/accounts?fields=id,name,access_token&limit=50&access_token=${encodeURIComponent(userToken)}`
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      logger.warn(`Messenger: /me/accounts ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
      return { ok: false, error: data?.error?.message || `HTTP ${res.status}` };
    }
    const pages = (data.data || []).filter((p) => p.id && p.access_token);
    return { ok: true, pages };
  } catch (err) {
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
