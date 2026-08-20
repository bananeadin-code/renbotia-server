import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../utils/jwt.js';

/**
 * Lógica de negocio de autenticación, sin acoplarse a req/res.
 */

function issueTokens(user) {
  const payload = { sub: user.id, role: user.role };
  return {
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken(payload),
  };
}

export async function registerUser({ name, email, password }) {
  const exists = await User.findOne({ email });
  if (exists) {
    throw ApiError.conflict('Ya existe una cuenta con ese email');
  }

  const user = new User({ name, email });
  await user.setPassword(password);
  await user.save();

  const tokens = issueTokens(user);
  return { user, ...tokens };
}

export async function loginUser({ email, password }) {
  // passwordHash tiene select:false → hay que pedirlo explícitamente
  const user = await User.findOne({ email }).select('+passwordHash');
  if (!user) {
    throw ApiError.unauthorized('Credenciales inválidas');
  }

  const ok = await user.comparePassword(password);
  if (!ok) {
    throw ApiError.unauthorized('Credenciales inválidas');
  }

  const tokens = issueTokens(user);
  return { user, ...tokens };
}

/* ─── Inicio de sesión con Google (verificación del ID token) ──────────────── */

let googleClient = null;
function getGoogleClient() {
  if (!env.google.clientId) {
    throw new ApiError(503, 'El inicio de sesión con Google no está configurado.');
  }
  if (!googleClient) googleClient = new OAuth2Client(env.google.clientId);
  return googleClient;
}

/**
 * Verifica el ID token de Google (firmado por Google) y devuelve nuestra sesión.
 * Si el correo ya tiene cuenta, la vincula; si no, crea una cuenta sin contraseña.
 * @param {string} credential - ID token JWT emitido por Google Identity Services
 */
export async function googleAuth(credential) {
  const client = getGoogleClient();
  let payload;
  try {
    const ticket = await client.verifyIdToken({ idToken: credential, audience: env.google.clientId });
    payload = ticket.getPayload();
  } catch {
    throw ApiError.unauthorized('No se pudo validar tu cuenta de Google.');
  }
  if (!payload?.email || !payload.email_verified) {
    throw ApiError.unauthorized('Tu correo de Google no está verificado.');
  }

  const email = payload.email.toLowerCase();
  const googleId = payload.sub;
  const name = payload.name || email.split('@')[0];

  let user = await User.findOne({ googleId }).select('+googleId');
  if (!user) {
    user = await User.findOne({ email }).select('+googleId');
    if (user) {
      // Ya existía con email/contraseña: vinculamos su cuenta de Google.
      if (!user.googleId) {
        user.googleId = googleId;
        await user.save();
      }
    } else {
      user = new User({ name, email, googleId });
      await user.save();
    }
  }

  return { user, ...issueTokens(user) };
}

export async function refreshTokens(refreshToken) {
  if (!refreshToken) {
    throw ApiError.unauthorized('Falta el refresh token');
  }

  const payload = verifyRefreshToken(refreshToken); // lanza si inválido/expirado
  const user = await User.findById(payload.sub);
  if (!user) {
    throw ApiError.unauthorized('El usuario ya no existe');
  }

  return issueTokens(user);
}

/**
 * Recuperación de contraseña SIMULADA: genera un token de reset y lo devuelve
 * directamente (en producción se enviaría por email). Sirve para mostrar el flujo.
 */
export async function requestPasswordReset(email) {
  const user = await User.findOne({ email });
  // No revelamos si el email existe o no (buena práctica anti-enumeración).
  if (!user) {
    return { resetToken: null, simulated: true };
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  user.resetToken = crypto.createHash('sha256').update(rawToken).digest('hex');
  user.resetTokenExpiry = new Date(Date.now() + 30 * 60 * 1000); // 30 min
  await user.save();

  // En el MVP devolvemos el token para poder completar el flujo sin email real.
  return { resetToken: rawToken, simulated: true };
}

export async function resetPassword({ token, password }) {
  const hashed = crypto.createHash('sha256').update(token).digest('hex');
  const user = await User.findOne({
    resetToken: hashed,
    resetTokenExpiry: { $gt: new Date() },
  }).select('+resetToken +resetTokenExpiry');

  if (!user) {
    throw ApiError.badRequest('Token de recuperación inválido o expirado');
  }

  await user.setPassword(password);
  user.resetToken = undefined;
  user.resetTokenExpiry = undefined;
  await user.save();

  return { ok: true };
}
