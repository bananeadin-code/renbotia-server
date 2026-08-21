import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

/**
 * Helpers para firmar y verificar los dos tipos de token.
 * - access token: corta duración, viaja en el header Authorization.
 * - refresh token: larga duración, se usa para emitir nuevos access tokens.
 */
export function signAccessToken(payload) {
  return jwt.sign(payload, env.jwt.accessSecret, {
    expiresIn: env.jwt.accessExpires,
  });
}

export function signRefreshToken(payload) {
  return jwt.sign(payload, env.jwt.refreshSecret, {
    expiresIn: env.jwt.refreshExpires,
  });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, env.jwt.accessSecret);
}

export function verifyRefreshToken(token) {
  return jwt.verify(token, env.jwt.refreshSecret);
}

/**
 * Token de "dispositivo recordado": permite saltar el 2FA en este navegador
 * durante 60 días. Firmado con el secreto de refresh + un kind distinto para
 * que no sirva como refresh token.
 */
export function signDeviceToken(userId) {
  return jwt.sign({ sub: String(userId), kind: 'device' }, env.jwt.refreshSecret, {
    expiresIn: '60d',
  });
}

export function verifyDeviceToken(token) {
  const payload = jwt.verify(token, env.jwt.refreshSecret);
  if (payload.kind !== 'device') throw new Error('token de dispositivo inválido');
  return payload;
}
