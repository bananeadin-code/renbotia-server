import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { fetchWithTimeout } from '../utils/http.js';
import { logger } from '../utils/logger.js';

/**
 * API de Conversiones de Meta (eventos desde el servidor). Complementa al Píxel
 * del navegador que instala la agencia: si el navegador bloquea el píxel, el
 * evento igual llega. Ambos mandan el MISMO event_id y Meta cuenta uno solo.
 *
 * Solo se envía si la persona aceptó las cookies de medición (adsConsent).
 * Variables: META_PIXEL_ID, META_CAPI_TOKEN, META_CAPI_API_VERSION (v26.0),
 * META_CAPI_TEST_CODE (opcional: eventos de prueba en el Administrador de eventos).
 */

const sha256 = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');

export function capiEnabled() {
  return Boolean(env.metaCapi.pixelId && env.metaCapi.token);
}

/** fbc a partir del fbclid del anuncio (formato que pide Meta). */
export function fbcFrom(fbclid, at = Date.now()) {
  return fbclid ? `fb.1.${at}.${fbclid}` : '';
}

/**
 * @param {object} p
 * @param {string} p.name         Evento estándar (CompleteRegistration, Purchase…) o propio.
 * @param {string} p.eventId      Igual al del navegador (deduplicación).
 * @param {object} p.user         Documento User (email, _id, acquisition).
 * @param {object} [p.ctx]        { ip, userAgent } de la petición actual, si la hay.
 * @param {object} [p.custom]     custom_data (value, currency, content_name…).
 * @param {string} [p.url]        Página donde ocurrió.
 */
export async function sendMetaEvent({ name, eventId, user, ctx = {}, custom = {}, url = '' }) {
  if (!capiEnabled() || !user) return { ok: false, skipped: 'disabled' };
  const acq = user.acquisition || {};
  if (!acq.adsConsent) return { ok: false, skipped: 'no_consent' };

  const userData = {
    em: [sha256(user.email)],
    external_id: [sha256(String(user._id))],
    client_ip_address: ctx.ip || acq.ip || undefined,
    client_user_agent: ctx.userAgent || acq.userAgent || undefined,
    fbp: acq.fbp || undefined,
    fbc: acq.fbc || fbcFrom(acq.fbclid, acq.firstSeenAt ? new Date(acq.firstSeenAt).getTime() : Date.now()) || undefined,
  };
  const body = {
    data: [
      {
        event_name: name,
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: 'website',
        event_source_url: url || `${env.publicUrl.replace(/\/$/, '')}/dashboard`,
        user_data: userData,
        custom_data: custom,
      },
    ],
    ...(env.metaCapi.testCode ? { test_event_code: env.metaCapi.testCode } : {}),
  };
  const apiUrl = `https://graph.facebook.com/${env.metaCapi.apiVersion}/${env.metaCapi.pixelId}/events?access_token=${encodeURIComponent(env.metaCapi.token)}`;
  try {
    const res = await fetchWithTimeout(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn(`Meta CAPI: ${name} rechazado (${res.status}) ${text.slice(0, 300)}`);
      return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (err) {
    logger.warn(`Meta CAPI: ${name} no se envió: ${err.message}`);
    return { ok: false, error: err.message };
  }
}
