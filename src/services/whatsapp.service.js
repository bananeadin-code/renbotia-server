import crypto from 'crypto';
import { env, isProd } from '../config/env.js';
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
  // Sin App Secret no podemos verificar. En PRODUCCIÓN cerramos (rechazamos) para
  // no aceptar webhooks sin firmar por un descuido de configuración; en desarrollo
  // dejamos pasar (para poder probar en local sin el secreto), avisando.
  if (!env.whatsapp.appSecret) {
    if (isProd) {
      logger.error('WhatsApp: WHATSAPP_APP_SECRET no configurado en producción; se rechaza el webhook.');
      return false;
    }
    logger.warn('WhatsApp: WHATSAPP_APP_SECRET no configurado (dev); se omite verificación de firma.');
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
      const err = data?.error || {};
      logger.error(`WhatsApp: fallo al enviar (${res.status}): ${JSON.stringify(err)}`);
      return { ok: false, error: err.message || `HTTP ${res.status}`, code: err.code, billing: isBillingError(err) };
    }
    return { ok: true, id: data?.messages?.[0]?.id };
  } catch (err) {
    logger.error(`WhatsApp: error de red al enviar: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * ¿El error de Meta indica que falta un MÉTODO DE PAGO / problema de elegibilidad
 * de facturación? Se usa para orientar al usuario a agregar su tarjeta en Meta.
 */
export function isBillingError(err) {
  if (!err) return false;
  if (Number(err.code) === 131042) return true; // "Business eligibility payment issue"
  const msg = `${err.message || ''} ${err.error_data?.details || ''}`.toLowerCase();
  return /payment|billing|método de pago|forma de pago/.test(msg);
}

/**
 * Envía un mensaje de PLANTILLA aprobada por la Cloud API. Es la ÚNICA forma de
 * escribirle a un cliente FUERA de la ventana de servicio de 24 h.
 *
 * @param {object} p
 * @param {string} p.phoneNumberId  id del número emisor (el del negocio)
 * @param {string} p.to             destinatario (wa_id / E.164 sin '+')
 * @param {string} p.templateName   nombre EXACTO de la plantilla aprobada en Meta
 * @param {string} [p.languageCode] código de idioma de la plantilla (ej. 'es_MX')
 * @param {string[]} [p.bodyParams] variables del cuerpo ({{1}}, {{2}}…), en orden
 * @returns {Promise<{ ok: boolean, id?: string, error?: string, code?: number, billing?: boolean }>}
 */
export async function sendTemplate({ phoneNumberId, to, templateName, languageCode = 'es_MX', bodyParams = [] }) {
  const id = phoneNumberId || env.whatsapp.phoneNumberId;
  if (!isConfigured() || !id) {
    logger.warn('WhatsApp: plantilla omitida (sin token o sin phoneNumberId).');
    return { ok: false, error: 'not_configured' };
  }

  const recipient = toWhatsAppNumber(to);
  const url = `${GRAPH}/${env.whatsapp.apiVersion}/${id}/messages`;
  const components = bodyParams.length
    ? [{ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: String(t) })) }]
    : undefined;
  const body = {
    messaging_product: 'whatsapp',
    to: recipient,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components ? { components } : {}),
    },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.whatsapp.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data?.error || {};
      logger.error(`WhatsApp: fallo al enviar plantilla (${res.status}): ${JSON.stringify(err)}`);
      return { ok: false, error: err.message || `HTTP ${res.status}`, code: err.code, billing: isBillingError(err) };
    }
    return { ok: true, id: data?.messages?.[0]?.id };
  } catch (err) {
    logger.error(`WhatsApp: error de red al enviar plantilla: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Lista las plantillas de mensaje de una WABA (para ofrecerlas en la bandeja
 * cuando la ventana de 24 h está cerrada). Solo se usan las APPROVED.
 * @returns {Promise<{ ok: boolean, templates: Array, error?: string }>}
 */
export async function listTemplates(wabaId) {
  if (!isConfigured() || !wabaId) return { ok: false, error: 'not_configured', templates: [] };
  const url = `${GRAPH}/${env.whatsapp.apiVersion}/${wabaId}/message_templates?fields=name,status,language,category&limit=100`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${env.whatsapp.token}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      logger.error(`WhatsApp: fallo al listar plantillas (${res.status}): ${JSON.stringify(data?.error || data)}`);
      return { ok: false, error: data?.error?.message || `HTTP ${res.status}`, templates: [] };
    }
    const templates = (data.data || []).map((t) => ({
      name: t.name,
      language: t.language,
      status: t.status,
      category: t.category,
    }));
    return { ok: true, templates };
  } catch (err) {
    logger.error(`WhatsApp: error de red al listar plantillas: ${err.message}`);
    return { ok: false, error: err.message, templates: [] };
  }
}

/**
 * Lee el perfil de WhatsApp Business del número (lo que el cliente ve en el chat:
 * "info", descripción, web, email, categoría, foto). El NOMBRE visible NO viene
 * aquí (es el verified name del alta).
 * @returns {Promise<{ ok: boolean, profile?: object, error?: string }>}
 */
export async function getBusinessProfile(phoneNumberId) {
  const id = phoneNumberId || env.whatsapp.phoneNumberId;
  if (!isConfigured() || !id) return { ok: false, error: 'not_configured' };
  const fields = 'about,address,description,email,profile_picture_url,websites,vertical';
  const url = `${GRAPH}/${env.whatsapp.apiVersion}/${id}/whatsapp_business_profile?fields=${fields}`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${env.whatsapp.token}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      logger.error(`WhatsApp: fallo al leer perfil (${res.status}): ${JSON.stringify(data?.error || data)}`);
      return { ok: false, error: data?.error?.message || `HTTP ${res.status}` };
    }
    return { ok: true, profile: data?.data?.[0] || {} };
  } catch (err) {
    logger.error(`WhatsApp: error de red al leer perfil: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Actualiza el perfil de WhatsApp Business. Solo campos editables por API:
 * about, description, email, websites[], vertical, address. (El nombre visible
 * NO se cambia aquí; requiere revisión de Meta.)
 */
export async function updateBusinessProfile(phoneNumberId, fields) {
  const id = phoneNumberId || env.whatsapp.phoneNumberId;
  if (!isConfigured() || !id) return { ok: false, error: 'not_configured' };
  const url = `${GRAPH}/${env.whatsapp.apiVersion}/${id}/whatsapp_business_profile`;
  const body = { messaging_product: 'whatsapp', ...fields };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.whatsapp.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      const err = data?.error || {};
      logger.error(`WhatsApp: fallo al actualizar perfil (${res.status}): ${JSON.stringify(err)}`);
      return { ok: false, error: err.message || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    logger.error(`WhatsApp: error de red al actualizar perfil: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Crea (envía a aprobación) una plantilla de texto en la WABA. Cuerpo estático
 * (sin variables) para no requerir ejemplos y facilitar la aprobación. Meta la
 * revisa: queda en estado PENDING hasta aprobarse.
 * @returns {Promise<{ ok: boolean, id?: string, status?: string, error?: string }>}
 */
export async function createTemplate(wabaId, { name, category, language = 'es_MX', bodyText }) {
  if (!isConfigured() || !wabaId) return { ok: false, error: 'not_configured' };
  const url = `${GRAPH}/${env.whatsapp.apiVersion}/${wabaId}/message_templates`;
  const body = {
    name,
    category,
    language,
    components: [{ type: 'BODY', text: bodyText }],
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.whatsapp.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data?.error || {};
      logger.error(`WhatsApp: fallo al crear plantilla (${res.status}): ${JSON.stringify(err)}`);
      return { ok: false, error: err.message || `HTTP ${res.status}` };
    }
    return { ok: true, id: data.id, status: data.status };
  } catch (err) {
    logger.error(`WhatsApp: error de red al crear plantilla: ${err.message}`);
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
