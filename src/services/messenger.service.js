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
 * Envía una imagen del negocio a un cliente de Messenger.
 * - url http(s): Meta la descarga (`payload.url`).
 * - data URI base64: se sube como adjunto en multipart (`filedata`).
 * @param {{ pageToken:string, recipientId:string, image:{label?:string,url:string} }} p
 * @returns {Promise<{ ok:boolean, id?:string, error?:string }>}
 */
export async function sendMessengerImage({ pageToken, recipientId, image }) {
  if (!pageToken || !recipientId) return { ok: false, error: 'missing_params' };
  const src = image?.url?.trim();
  if (!src) return { ok: false, error: 'imagen sin url' };

  const url = `${GRAPH()}/me/messages?access_token=${encodeURIComponent(pageToken)}`;
  const recipient = JSON.stringify({ id: recipientId });
  let init;
  if (/^https?:\/\//i.test(src)) {
    init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientId },
        messaging_type: 'RESPONSE',
        message: { attachment: { type: 'image', payload: { url: src, is_reusable: false } } },
      }),
    };
  } else {
    const m = /^data:([^;]+);base64,(.+)$/s.exec(src);
    if (!m) return { ok: false, error: 'formato de imagen no soportado' };
    const mime = m[1];
    const form = new FormData();
    form.append('recipient', recipient);
    form.append('messaging_type', 'RESPONSE');
    form.append('message', JSON.stringify({ attachment: { type: 'image', payload: { is_reusable: false } } }));
    const ext = mime.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
    form.append('filedata', new Blob([Buffer.from(m[2], 'base64')], { type: mime }), `imagen.${ext}`);
    // Sin 'Content-Type' manual: fetch pone el boundary del multipart.
    init = { method: 'POST', body: form };
  }

  try {
    const res = await fetch(url, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      logger.warn(`Messenger: envío de imagen ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
      return { ok: false, error: data?.error?.message || `HTTP ${res.status}` };
    }
    return { ok: true, id: data.message_id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Nombre del cliente a partir de su PSID (User Profile API, incluido en
 * pages_messaging para quien escribió a la Página). Fail-soft: '' si no se puede.
 */
export async function getMessengerProfileName(psid, pageToken) {
  if (!psid || !pageToken) return '';
  try {
    const res = await fetch(
      `${GRAPH()}/${psid}?fields=first_name,last_name&access_token=${encodeURIComponent(pageToken)}`
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return '';
    return [data.first_name, data.last_name].filter(Boolean).join(' ').trim();
  } catch {
    return '';
  }
}

/**
 * Descarga una imagen que el cliente mandó por Messenger (la URL del CDN de Meta
 * es pública y temporal). Devuelve base64 para pasársela al bot. Tope de 5 MB.
 * @returns {Promise<{ ok:boolean, mime?:string, base64?:string }>}
 */
export async function downloadMessengerImage(url) {
  if (!url) return { ok: false };
  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false };
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
    const buf = Buffer.from(await res.arrayBuffer());
    if (!/^image\//.test(mime) || buf.length > 5 * 1024 * 1024) return { ok: false };
    return { ok: true, mime, base64: buf.toString('base64') };
  } catch {
    return { ok: false };
  }
}

/**
 * Verifica con Meta (debug_token) que un token de usuario que llega del navegador
 * es válido y fue emitido para NUESTRA app. Evita que alguien nos pase un token de
 * otra app. Se usa en el flujo de FB Login for Business (variación General), que
 * entrega el token directamente en lugar de un `code`.
 * @returns {Promise<{ ok:boolean, error?:string }>}
 */
export async function verifyUserToken(userToken) {
  try {
    const appToken = `${env.whatsapp.appId}|${env.whatsapp.appSecret}`;
    const res = await fetch(
      `${GRAPH()}/debug_token?input_token=${encodeURIComponent(userToken)}&access_token=${encodeURIComponent(appToken)}`
    );
    const body = await res.json().catch(() => ({}));
    const d = body?.data || {};
    if (!res.ok || !d.is_valid) {
      return { ok: false, error: d?.error?.message || body?.error?.message || 'token inválido' };
    }
    if (String(d.app_id) !== String(env.whatsapp.appId)) {
      return { ok: false, error: 'el token no pertenece a esta app' };
    }
    return { ok: true };
  } catch (err) {
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
