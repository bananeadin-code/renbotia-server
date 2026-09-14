import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

/**
 * Helpers para firmar y verificar los tres tipos de token.
 * - access token:  corta duración, viaja en el header Authorization.
 * - refresh token: larga duración, se usa para emitir nuevos access tokens.
 * - device token:  60 días, permite saltar el 2FA en un navegador de confianza.
 *
 * Endurecimiento de seguridad:
 *  1) Algoritmo FIJO (HS256) al firmar y verificar → evita ataques de sustitución
 *     de algoritmo (p. ej. forzar `alg: none` o confusión HS/RS).
 *  2) Cada token lleva un claim `typ` y se EXIGE al verificar → un tipo de token
 *     no puede usarse en lugar de otro (un device token no vale como refresh, etc.),
 *     aunque compartan secreto.
 */
const ALGO = 'HS256';
const verifyOpts = { algorithms: [ALGO] };

/** Verifica el token y exige que su `typ` sea el esperado; si no, 401. */
function verifyTyped(token, secret, expectedTyp) {
  const payload = jwt.verify(token, secret, verifyOpts);
  if (payload.typ !== expectedTyp) {
    // Mismo tipo de error que un token inválido → el errorHandler lo mapea a 401.
    throw new jwt.JsonWebTokenError('tipo de token inválido');
  }
  return payload;
}

export function signAccessToken(payload) {
  return jwt.sign({ ...payload, typ: 'access' }, env.jwt.accessSecret, {
    expiresIn: env.jwt.accessExpires,
    algorithm: ALGO,
  });
}

export function signRefreshToken(payload) {
  return jwt.sign({ ...payload, typ: 'refresh' }, env.jwt.refreshSecret, {
    expiresIn: env.jwt.refreshExpires,
    algorithm: ALGO,
  });
}

export function verifyAccessToken(token) {
  return verifyTyped(token, env.jwt.accessSecret, 'access');
}

export function verifyRefreshToken(token) {
  return verifyTyped(token, env.jwt.refreshSecret, 'refresh');
}

/**
 * Token de "dispositivo recordado": salta el 2FA en este navegador 60 días.
 * Firmado con el secreto de refresh, pero con `typ: 'device'` para que NO pueda
 * usarse como refresh token (ni al revés).
 */
export function signDeviceToken(userId) {
  return jwt.sign({ sub: String(userId), typ: 'device' }, env.jwt.refreshSecret, {
    expiresIn: '60d',
    algorithm: ALGO,
  });
}

export function verifyDeviceToken(token) {
  return verifyTyped(token, env.jwt.refreshSecret, 'device');
}
