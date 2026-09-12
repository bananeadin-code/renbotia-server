import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Onboarding self-serve de WhatsApp (Embedded Signup / Facebook Login for
 * Business). El cliente conecta SU propia cuenta de WhatsApp (WABA); estas
 * funciones completan el enlace del lado del servidor:
 *   1) exchangeCode:   canjea el `code` del signup por un token de acceso.
 *   2) subscribeApp:   suscribe NUESTRA app a la WABA del cliente (webhooks).
 *   3) registerPhone:  registra el número en la Cloud API (best-effort).
 *
 * Para ENVIAR mensajes se sigue usando el token de sistema (env.whatsapp.token):
 * al hacer Embedded Signup, la WABA del cliente queda compartida con nuestro
 * portafolio, así que un solo token de sistema envía por todos los clientes.
 */

const GRAPH = 'https://graph.facebook.com';

/** Canjea el `code` del Embedded Signup por un token de acceso a la WABA. */
export async function exchangeCode(code) {
  const url = new URL(`${GRAPH}/${env.whatsapp.apiVersion}/oauth/access_token`);
  url.searchParams.set('client_id', env.whatsapp.appId);
  url.searchParams.set('client_secret', env.whatsapp.appSecret);
  url.searchParams.set('code', code);

  try {
    const res = await fetch(url, { method: 'GET' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      logger.error(`WhatsApp Embedded: fallo al canjear code (${res.status}): ${JSON.stringify(data?.error || data)}`);
      return { ok: false, error: data?.error?.message || `HTTP ${res.status}` };
    }
    return { ok: true, token: data.access_token };
  } catch (err) {
    logger.error(`WhatsApp Embedded: error de red al canjear code: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/** Suscribe NUESTRA app a la WABA del cliente (para recibir sus webhooks). */
export async function subscribeApp(wabaId, token) {
  try {
    const res = await fetch(`${GRAPH}/${env.whatsapp.apiVersion}/${wabaId}/subscribed_apps`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      logger.error(`WhatsApp Embedded: fallo subscribed_apps (${res.status}): ${JSON.stringify(data?.error || data)}`);
      return { ok: false, error: data?.error?.message || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    logger.error(`WhatsApp Embedded: error de red en subscribed_apps: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Registra el número en la Cloud API (necesario para enviar/recibir). Requiere
 * un PIN de verificación en dos pasos (6 dígitos). Best-effort: si el número ya
 * estaba registrado, Meta responde error y NO bloqueamos la conexión.
 */
export async function registerPhone(phoneNumberId, token, pin) {
  try {
    const res = await fetch(`${GRAPH}/${env.whatsapp.apiVersion}/${phoneNumberId}/register`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      logger.warn(`WhatsApp Embedded: registro de número no confirmado (${res.status}): ${JSON.stringify(data?.error || data)}`);
      return { ok: false, error: data?.error?.message || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    logger.warn(`WhatsApp Embedded: error de red al registrar número: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Deduce la WABA y el número desde el token del cliente (robustez): tras el
 * Embedded Signup, el token concede acceso a las cuentas de WhatsApp del cliente.
 * Con debug_token leemos los `granular_scopes` (que traen los IDs de WABA
 * concedidos) y luego consultamos el/los números de esa WABA. Así NO dependemos
 * de que el navegador nos pase el número por postMessage.
 *
 * @returns {Promise<{ ok: boolean, wabaId?: string, phoneNumberId?: string, error?: string }>}
 */
export async function resolveWabaAndPhone(userToken) {
  const version = env.whatsapp.apiVersion;
  const appToken = `${env.whatsapp.appId}|${env.whatsapp.appSecret}`;

  // 1) debug_token → WABA(s) concedidas en los scopes granulares.
  let wabaId = '';
  try {
    const url = `${GRAPH}/${version}/debug_token?input_token=${encodeURIComponent(userToken)}&access_token=${encodeURIComponent(appToken)}`;
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    const scopes = data?.data?.granular_scopes || [];
    const waScope =
      scopes.find((s) => s.scope === 'whatsapp_business_management') ||
      scopes.find((s) => s.scope === 'whatsapp_business_messaging');
    wabaId = waScope?.target_ids?.[0] || '';
  } catch (err) {
    logger.error(`WhatsApp Embedded: debug_token falló: ${err.message}`);
    return { ok: false, error: err.message };
  }
  if (!wabaId) return { ok: false, error: 'no_waba' };

  // 2) Número(s) de esa WABA.
  try {
    const url = `${GRAPH}/${version}/${wabaId}/phone_numbers?access_token=${encodeURIComponent(userToken)}`;
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    const phoneNumberId = data?.data?.[0]?.id || '';
    if (!phoneNumberId) return { ok: false, error: 'no_phone', wabaId };
    return { ok: true, wabaId, phoneNumberId };
  } catch (err) {
    logger.error(`WhatsApp Embedded: phone_numbers falló: ${err.message}`);
    return { ok: false, error: err.message };
  }
}
