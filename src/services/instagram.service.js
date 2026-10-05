import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { splitMessage } from '../utils/splitMessage.js';
import { GRAPH, postPageMessage } from './messenger.service.js';

/**
 * Adaptador de Instagram DMs (API de Instagram con inicio de sesión de Facebook).
 *
 * La cuenta profesional de Instagram vive ligada a una Página de Facebook: los
 * mensajes llegan al webhook con `object: 'instagram'` (entry.id = id de la
 * cuenta de IG, sender.id = IGSID del cliente) y se responden con el TOKEN DE LA
 * PÁGINA ligada en /me/messages, igual que Messenger.
 */

const IG_TEXT_MAX = 1000; // límite de caracteres por mensaje en Instagram

/** Envía texto a un cliente de Instagram (en varios mensajes si es largo). */
export async function sendInstagramText({ pageToken, recipientId, text }) {
  if (!pageToken || !recipientId) {
    logger.warn('Instagram: envío omitido (sin token de página o destinatario).');
    return { ok: false, error: 'missing_params' };
  }
  let last = { ok: false, error: 'empty' };
  for (const chunk of splitMessage(text, IG_TEXT_MAX)) {
    last = await postPageMessage(pageToken, { recipient: { id: recipientId }, message: { text: chunk } }, 'Instagram');
    if (!last.ok) break;
  }
  return last;
}

/**
 * URL pública de una imagen del bot. Instagram solo acepta imágenes por URL (no
 * data URI ni subida directa); las subidas al panel se sirven desde
 * /api/media/bot-image/:id.
 */
export function publicImageUrl(image) {
  const src = image?.url?.trim() || '';
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith('data:') && image?.id) {
    return `${env.clientUrl.replace(/\/$/, '')}/api/media/bot-image/${image.id}`;
  }
  return '';
}

/** Envía una imagen del negocio a un cliente de Instagram. */
export async function sendInstagramImage({ pageToken, recipientId, image }) {
  if (!pageToken || !recipientId) return { ok: false, error: 'missing_params' };
  const url = publicImageUrl(image);
  if (!url) return { ok: false, error: 'imagen sin URL pública' };
  return postPageMessage(
    pageToken,
    { recipient: { id: recipientId }, message: { attachment: { type: 'image', payload: { url } } } },
    'Instagram'
  );
}

/** Nombre del cliente (o su @usuario) a partir del IGSID. Fail-soft: ''. */
export async function getInstagramProfileName(igsid, pageToken) {
  if (!igsid || !pageToken) return '';
  try {
    const res = await fetch(`${GRAPH()}/${igsid}?fields=name,username&access_token=${encodeURIComponent(pageToken)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return '';
    return (data.name || (data.username ? `@${data.username}` : '')).trim();
  } catch {
    return '';
  }
}

/**
 * Páginas concedidas en el login que tienen una cuenta de Instagram profesional
 * ligada, con su token de Página.
 * @returns {Promise<{ ok:boolean, accounts?: Array<{pageId,pageName,pageToken,igId,username,picture}>, pagesCount?:number, error?:string }>}
 */
export async function listInstagramAccounts(userToken) {
  try {
    const fields = 'id,name,access_token,instagram_business_account{id,username,profile_picture_url}';
    const res = await fetch(
      `${GRAPH()}/me/accounts?fields=${encodeURIComponent(fields)}&limit=50&access_token=${encodeURIComponent(userToken)}`
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      logger.warn(`Instagram: /me/accounts ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
      return { ok: false, error: data?.error?.message || `HTTP ${res.status}` };
    }
    const pages = data.data || [];
    const accounts = pages
      .filter((p) => p.access_token && p.instagram_business_account?.id)
      .map((p) => ({
        pageId: p.id,
        pageName: p.name || '',
        pageToken: p.access_token,
        igId: p.instagram_business_account.id,
        username: p.instagram_business_account.username || '',
        picture: p.instagram_business_account.profile_picture_url || '',
      }));
    return { ok: true, accounts, pagesCount: pages.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
