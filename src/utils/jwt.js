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
