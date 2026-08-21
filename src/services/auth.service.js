import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';
import { sendPasswordResetEmail } from './email.service.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  signDeviceToken,
  verifyDeviceToken,
} from '../utils/jwt.js';
import { sendOtp, verifyOtp } from './otp.service.js';

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

  // La cuenta se crea SIN verificar: primero debe confirmar el código del correo.
  const user = new User({ name, email, emailVerified: false });
  await user.setPassword(password);
  await user.save();

  const otp = await sendOtp({ user, purpose: 'verify_email' });
  // No emitimos tokens aún: el cliente pide el código y llama a verify-email.
  return { needsEmailVerification: true, email: user.email, ...otp };
}

export async function loginUser({ email, password, deviceToken }) {
  // passwordHash tiene select:false → hay que pedirlo explícitamente
  const user = await User.findOne({ email }).select('+passwordHash +googleId');
  if (!user) {
    throw ApiError.unauthorized('Credenciales inválidas');
  }

  // Cuentas creadas con Google no tienen contraseña: guiamos en vez de
  // reventar bcrypt con "Illegal arguments: string, undefined".
  if (!user.passwordHash) {
    throw ApiError.badRequest(
      'Esta cuenta se creó con Google. Entra con el botón "Continuar con Google".'
    );
  }

  const ok = await user.comparePassword(password);
  if (!ok) {
    throw ApiError.unauthorized('Credenciales inválidas');
  }

  // Correo sin verificar: primero confirmar el email (reenvía código).
  if (!user.emailVerified) {
    const otp = await sendOtp({ user, purpose: 'verify_email' });
    return { needsEmailVerification: true, email: user.email, ...otp };
  }

  // 2FA por email, salvo dispositivo recordado (cookie firmada de 60 días).
  if (user.twoFactorEnabled && !isDeviceRemembered(deviceToken, user._id)) {
    const otp = await sendOtp({ user, purpose: 'login_2fa' });
    return { needs2fa: true, email: user.email, ...otp };
  }

  const tokens = issueTokens(user);
  return { user, ...tokens };
}

/** ¿El token de dispositivo es válido y pertenece a este usuario? */
function isDeviceRemembered(deviceToken, userId) {
  if (!deviceToken) return false;
  try {
    const payload = verifyDeviceToken(deviceToken);
    return String(payload.sub) === String(userId);
  } catch {
    return false;
  }
}

/**
 * Confirma el correo con el código y deja la cuenta activa (e inicia sesión).
 */
export async function verifyEmailAndLogin({ email, code }) {
  const user = await User.findOne({ email });
  if (!user) throw ApiError.badRequest('No encontramos esa cuenta.');
  await verifyOtp({ userId: user._id, purpose: 'verify_email', code });
  if (!user.emailVerified) {
    user.emailVerified = true;
    await user.save();
  }
  const tokens = issueTokens(user);
  return { user, ...tokens };
}

/**
 * Verifica el 2FA del login y emite sesión. Si rememberDevice, devuelve además
 * un deviceToken para que el controlador lo fije como cookie (salta 2FA 60 días).
 */
export async function verify2faAndLogin({ email, code, rememberDevice }) {
  const user = await User.findOne({ email });
  if (!user) throw ApiError.badRequest('No encontramos esa cuenta.');
  await verifyOtp({ userId: user._id, purpose: 'login_2fa', code });
  const tokens = issueTokens(user);
  const deviceToken = rememberDevice ? signDeviceToken(user._id) : null;
  return { user, ...tokens, deviceToken };
}

/**
 * Reenvía un código OTP. Anti-enumeración: siempre responde ok aunque el correo
 * no exista. `purpose` distingue verificación de correo vs 2FA de login.
 */
export async function resendOtpCode({ email, purpose }) {
  const user = await User.findOne({ email });
  if (!user) return { sent: true }; // no revelamos si existe
  return sendOtp({ user, purpose });
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
      // Ya existía con email/contraseña: vinculamos su cuenta de Google. Su correo
      // queda verificado (Google ya lo confirmó).
      let changed = false;
      if (!user.googleId) {
        user.googleId = googleId;
        changed = true;
      }
      if (!user.emailVerified) {
        user.emailVerified = true;
        changed = true;
      }
      if (changed) await user.save();
    } else {
      // Cuenta nueva por Google: verificada de origen y sin 2FA (Google autentica).
      user = new User({ name, email, googleId, emailVerified: true });
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

  // Enviar el correo con el enlace a la página de restablecimiento (fail-open:
  // si Resend no está configurado, se registra y no rompe el flujo).
  const link = `${env.publicUrl.replace(/\/$/, '')}/restablecer?token=${rawToken}`;
  await sendPasswordResetEmail({ to: user.email, customerName: user.name, link, minutes: 30 });

  // En desarrollo devolvemos también el token para probar sin correo real.
  return { resetToken: rawToken, simulated: false };
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
