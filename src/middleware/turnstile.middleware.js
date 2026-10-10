import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';

/**
 * Cloudflare Turnstile: confirma que quien crea una cuenta (o pide recuperar la
 * contraseña) es una persona, sin pedirle resolver nada en la mayoría de los
 * casos. Se activa solo si existe TURNSTILE_SECRET_KEY (y en el cliente
 * VITE_TURNSTILE_SITE_KEY). Si Cloudflare no responde, deja pasar y lo anota:
 * es una barrera contra bots, no la que protege las cuentas.
 */
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function turnstileEnabled() {
  return Boolean(process.env.TURNSTILE_SECRET_KEY);
}

export async function verifyTurnstileToken(token, ip) {
  const body = new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY, response: String(token || '') });
  if (ip) body.set('remoteip', ip);
  const r = await fetch(VERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(5000) });
  const data = await r.json();
  return Boolean(data.success);
}

export async function requireHuman(req, res, next) {
  if (!turnstileEnabled()) return next();
  const token = req.body?.turnstileToken;
  if (!token) return next(new ApiError(400, 'Confirma que eres una persona para continuar.', { code: 'CAPTCHA_REQUIRED' }));
  try {
    const ok = await verifyTurnstileToken(token, req.ip);
    if (!ok) return next(new ApiError(400, 'No pudimos confirmar que eres una persona. Recarga la página e intenta de nuevo.', { code: 'CAPTCHA_FAILED' }));
  } catch (err) {
    logger.warn(`Turnstile no disponible, se deja pasar: ${err.message}`);
  }
  next();
}
