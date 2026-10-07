import { sendEmail } from './email.service.js';
import { logger } from '../utils/logger.js';

/**
 * Alertas de operación por correo (sin servicios extra): errores 500, fallos
 * del proceso y del cobrador llegan a ALERT_EMAIL. Anti-spam: el mismo error
 * (misma "firma") se avisa como mucho una vez por hora, con un conteo de
 * repeticiones, y nunca más de ALERT_DAILY_MAX correos al día.
 *
 * Fail-open: si el correo falla, solo se registra; jamás rompe la petición.
 */

const HOUR = 3600 * 1000;
const seen = new Map(); // firma → { last, count }
let day = '';
let sentToday = 0;

const escapeHtml = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Quita ids y números para agrupar errores iguales con datos distintos.
const signatureOf = (kind, message) =>
  `${kind}:${String(message || '')
    .replace(/[0-9a-f]{24}/gi, ':id')
    .replace(/\d+/g, 'N')
    .slice(0, 160)}`;

/**
 * @param {object} p
 * @param {string} p.kind     Origen: 'http_500', 'unhandled_rejection', 'renewal', etc.
 * @param {string} p.message  Resumen del error.
 * @param {string} [p.detail] Stack o contexto (se recorta).
 */
export function alertOps({ kind, message, detail }) {
  const to = process.env.ALERT_EMAIL;
  if (!to) return;

  const sig = signatureOf(kind, message);
  const now = Date.now();
  const entry = seen.get(sig) || { last: 0, count: 0 };
  entry.count += 1;
  seen.set(sig, entry);
  if (now - entry.last < HOUR) return; // ya avisado hace menos de 1 h
  if (seen.size > 500) seen.clear(); // cota de memoria

  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    sentToday = 0;
  }
  const max = Number(process.env.ALERT_DAILY_MAX) || 20;
  if (sentToday >= max) return;

  const repeats = entry.count;
  entry.last = now;
  entry.count = 0;
  sentToday += 1;

  const env = process.env.RENDER_SERVICE_NAME || process.env.NODE_ENV || 'server';
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;color:#0f172a">
  <p style="margin:0 0 8px"><b>RenBotIA · alerta (${escapeHtml(kind)})</b> en ${escapeHtml(env)}</p>
  <p style="margin:0 0 8px">${escapeHtml(message)}</p>
  ${repeats > 1 ? `<p style="margin:0 0 8px;color:#b45309">Se repitió ${repeats} veces desde el último aviso.</p>` : ''}
  ${detail ? `<pre style="white-space:pre-wrap;background:#f1f5f9;padding:10px;border-radius:8px;font-size:12px">${escapeHtml(String(detail).slice(0, 4000))}</pre>` : ''}
  <p style="margin:8px 0 0;color:#64748b;font-size:12px">${new Date().toISOString()}</p>
</div>`;

  sendEmail({ to, subject: `[RenBotIA] ${kind}: ${String(message).slice(0, 80)}`, html }).catch((err) =>
    logger.warn(`Alerta: no se pudo enviar (${err.message})`)
  );
}

/** Errores fuera de una petición (promesas sin catch, excepciones). */
export function installProcessAlerts() {
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error(`Promesa sin manejar: ${err.stack || err.message}`);
    alertOps({ kind: 'unhandled_rejection', message: err.message, detail: err.stack });
  });
  process.on('uncaughtException', (err) => {
    logger.error(`Excepción no capturada: ${err.stack || err.message}`);
    alertOps({ kind: 'uncaught_exception', message: err.message, detail: err.stack });
    // Estado incierto: se deja que Render reinicie el proceso tras enviar el aviso.
    setTimeout(() => process.exit(1), 3000).unref?.();
  });
}
