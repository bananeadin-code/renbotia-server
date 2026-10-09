import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';
import { sendPasswordResetEmail, sendWelcomeEmail } from './email.service.js';
import { isDisposableEmail } from '../utils/disposableEmails.js';
import { verifyRefreshToken, signDeviceToken, verifyDeviceToken } from '../utils/jwt.js';
import { startSession, rotateSession, revokeAllSessions } from './session.service.js';
import { sendSecurityEmail } from './email.service.js';
import { sendOtp, verifyOtp } from './otp.service.js';
import { logger } from '../utils/logger.js';
import { resolveReferrer } from './referral.service.js';
import { Business } from '../models/Business.js';

/**
 * Lógica de negocio de autenticación, sin acoplarse a req/res.
 */

// Bloqueo de cuenta: tras N fallos seguidos, se bloquea M minutos.
const MAX_LOGIN_ATTEMPTS = 8;
const LOCK_MINUTES = 15;

// Cada inicio de sesión exitoso crea una sesión en servidor (ver session.service).
async function issueTokens(user, ctx) {
  const { accessToken, refreshToken } = await startSession({ user, ctx });
  return { accessToken, refreshToken };
}

export async function registerUser({ name, email, password, ref }) {
  // Bloqueo de correos desechables/temporales (anti-abuso de cuentas Free).
  if (isDisposableEmail(email)) {
    throw ApiError.badRequest(
      'Usa un correo permanente para crear tu cuenta (no se permiten correos temporales o desechables).'
    );
  }

  const exists = await User.findOne({ email });
  if (exists) {
    throw ApiError.conflict('Ya existe una cuenta con ese email');
  }

  // La cuenta se crea SIN verificar: primero debe confirmar el código del correo.
  const user = new User({ name, email, emailVerified: false, referredBy: await resolveReferrer(ref) });
  await user.setPassword(password);
  await user.save();

  const otp = await sendOtp({ user, purpose: 'verify_email' });
  // No emitimos tokens aún: el cliente pide el código y llama a verify-email.
  return { needsEmailVerification: true, email: user.email, ...otp };
}

export async function loginUser({ email, password, deviceToken, ctx = {} }) {
  const ip = ctx.ip;
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

  // Bloqueo temporal por intentos fallidos (por cuenta, complementa el rate-limit por IP).
  if (user.lockUntil && user.lockUntil > new Date()) {
    logger.warn(`Auth: login rechazado, cuenta bloqueada — ${email} ip=${ip || '?'}`);
    throw new ApiError(
      429,
      'Cuenta bloqueada temporalmente por varios intentos fallidos. Intenta de nuevo en unos minutos.',
      { code: 'ACCOUNT_LOCKED' }
    );
  }

  const ok = await user.comparePassword(password);
  if (!ok) {
    user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
    if (user.failedLoginAttempts >= MAX_LOGIN_ATTEMPTS) {
      user.lockUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
      logger.warn(`Auth: cuenta BLOQUEADA por ${MAX_LOGIN_ATTEMPTS} intentos — ${email} ip=${ip || '?'}`);
      // Aviso al dueño de la cuenta: si no fue él, alguien intenta adivinar su contraseña.
      void sendSecurityEmail({
        kind: 'account_locked',
        to: user.email,
        customerName: user.name,
        minutes: LOCK_MINUTES,
        url: `${env.publicUrl.replace(/\/$/, '')}/dashboard/perfil#sesiones`,
        resetUrl: `${env.publicUrl.replace(/\/$/, '')}/recuperar`,
      });
    } else {
      logger.warn(`Auth: login fallido (${user.failedLoginAttempts}/${MAX_LOGIN_ATTEMPTS}) — ${email} ip=${ip || '?'}`);
    }
    await user.save();
    throw ApiError.unauthorized('Credenciales inválidas');
  }

  // Éxito: limpia contador/bloqueo si venía con fallos.
  if (user.failedLoginAttempts > 0 || user.lockUntil) {
    user.failedLoginAttempts = 0;
    user.lockUntil = undefined;
    await user.save();
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

  const tokens = await issueTokens(user, ctx);
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
export async function verifyEmailAndLogin({ email, code, ctx = {} }) {
  const user = await User.findOne({ email });
  if (!user) throw ApiError.badRequest('No encontramos esa cuenta.');
  await verifyOtp({ userId: user._id, purpose: 'verify_email', code });
  if (!user.emailVerified) {
    user.emailVerified = true;
    await user.save();
    // Bienvenida (cálida) al activar la cuenta. Fail-open, no bloquea el login.
    void sendWelcomeEmail({ to: user.email, customerName: user.name });
  }
  const tokens = await issueTokens(user, ctx);
  return { user, ...tokens };
}

/**
 * Verifica el 2FA del login y emite sesión. Si rememberDevice, devuelve además
 * un deviceToken para que el controlador lo fije como cookie (salta 2FA 60 días).
 */
export async function verify2faAndLogin({ email, code, rememberDevice, ctx = {} }) {
  const user = await User.findOne({ email });
  if (!user) throw ApiError.badRequest('No encontramos esa cuenta.');
  await verifyOtp({ userId: user._id, purpose: 'login_2fa', code });
  const tokens = await issueTokens(user, ctx);
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

/**
 * Solicita cambiar el correo del usuario: envía un código al correo NUEVO para
 * probar que le pertenece. No cambia nada hasta que se verifica.
 */
export async function requestEmailChange({ userId, newEmail }) {
  const email = String(newEmail).trim().toLowerCase();
  const user = await User.findById(userId);
  if (!user) throw ApiError.unauthorized('No autenticado');
  if (email === user.email) throw ApiError.badRequest('Ese ya es tu correo actual.');
  if (isDisposableEmail(email)) {
    throw ApiError.badRequest('Usa un correo permanente (no temporal o desechable).');
  }
  const taken = await User.findOne({ email });
  if (taken) throw ApiError.conflict('Ya existe una cuenta con ese correo.');

  const otp = await sendOtp({ user, purpose: 'change_email', to: email, pendingEmail: email });
  return { sent: true, newEmail: email, ...otp };
}

/** Confirma el cambio de correo con el código enviado al correo nuevo. */
export async function verifyEmailChange({ userId, code }) {
  const user = await User.findById(userId);
  if (!user) throw ApiError.unauthorized('No autenticado');

  const { pendingEmail } = await verifyOtp({ userId, purpose: 'change_email', code });
  if (!pendingEmail) throw ApiError.badRequest('No hay un cambio de correo pendiente.');

  // Revalida que no lo hayan tomado entre la solicitud y la verificación.
  const taken = await User.findOne({ email: pendingEmail, _id: { $ne: user._id } });
  if (taken) throw ApiError.conflict('Ese correo acaba de ser tomado por otra cuenta.');

  user.email = pendingEmail;
  user.emailVerified = true;
  await user.save();
  return { user };
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
export async function googleAuth(credential, ref, ctx = {}) {
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
      user = new User({ name, email, googleId, emailVerified: true, referredBy: await resolveReferrer(ref) });
      await user.save();
      void sendWelcomeEmail({ to: user.email, customerName: user.name });
    }
  }

  return { user, ...(await issueTokens(user, ctx)) };
}

/**
 * Renueva la sesión con el refresh token: valida firma y vigencia, y delega en
 * la sesión de servidor (rotación del jti, inactividad, detección de robo).
 */
export async function refreshTokens(refreshToken, ctx = {}) {
  if (!refreshToken) {
    throw ApiError.unauthorized('Falta el refresh token');
  }
  const payload = verifyRefreshToken(refreshToken); // lanza si inválido/expirado
  return rotateSession(payload, ctx);
}

/**
 * Recuperación de contraseña: genera un token de un solo uso (se guarda su hash)
 * y lo envía por correo. Nunca se devuelve en la respuesta de la API.
 */
export async function requestPasswordReset(email) {
  const user = await User.findOne({ email });
  // No revelamos si el email existe o no (buena práctica anti-enumeración).
  if (!user) {
    return { sent: true };
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  user.resetToken = crypto.createHash('sha256').update(rawToken).digest('hex');
  user.resetTokenExpiry = new Date(Date.now() + 30 * 60 * 1000); // 30 min
  await user.save();

  // Enviar el correo con el enlace a la página de restablecimiento (fail-open:
  // si Resend no está configurado, se registra y no rompe el flujo).
  const link = `${env.publicUrl.replace(/\/$/, '')}/restablecer?token=${rawToken}`;
  await sendPasswordResetEmail({ to: user.email, customerName: user.name, link, minutes: 30 });

  return { sent: true };
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
  // Invalida TODAS las sesiones existentes (recuperación ante robo de cuenta) y
  // limpia cualquier bloqueo por intentos.
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  user.failedLoginAttempts = 0;
  user.lockUntil = undefined;
  await user.save();
  await revokeAllSessions(user._id, { reason: 'password_reset' });
  // Seguridad: también se desvinculan sus números de WhatsApp de dueño.
  await Business.updateMany({ owner: user._id }, { $set: { ownerWhatsApp: [], 'ownerPending.action': '' } });
  logger.info(`Auth: contraseña restablecida, sesiones invalidadas — userId=${user.id}`);

  return { ok: true };
}
