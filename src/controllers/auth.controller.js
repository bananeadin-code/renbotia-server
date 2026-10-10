import { z } from 'zod';
import * as passkeys from '../services/passkey.service.js';
import { securityOverview } from '../services/securityOverview.service.js';
import { turnstileEnabled } from '../middleware/turnstile.middleware.js';
import * as accessService from '../services/access.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import * as authService from '../services/auth.service.js';
import { deleteAccount as deleteAccountService } from '../services/account.service.js';
import { User } from '../models/User.js';
import { env, isProd } from '../config/env.js';
import { requestContext, revokeSession, revokeAllSessions, listSessions, listContexts } from '../services/session.service.js';
import { verifyRefreshToken } from '../utils/jwt.js';
import { ApiError } from '../utils/ApiError.js';
import { sendSecurityEmail } from '../services/email.service.js';
import { describeDevice } from '../utils/userAgent.js';

/**
 * Esquemas de validación (Zod). Se exportan para usarse en las rutas.
 */
export const registerSchema = z.object({
  name: z.string().min(2, 'El nombre debe tener al menos 2 caracteres'),
  email: z.string().email('Email inválido'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
  ref: z.string().max(16).optional(), // código de referido (enlace de invitación)
});

export const loginSchema = z.object({
  email: z.string().email('Email inválido'),
  password: z.string().min(1, 'La contraseña es obligatoria'),
});

export const forgotSchema = z.object({
  email: z.string().email('Email inválido'),
});

export const resetSchema = z.object({
  token: z.string().min(10, 'Token inválido'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
});

export const verifyEmailSchema = z.object({
  email: z.string().email('Email inválido'),
  code: z.string().regex(/^\d{6}$/, 'Código de 6 dígitos.'),
});

export const verify2faSchema = z.object({
  email: z.string().email('Email inválido'),
  code: z.string().regex(/^\d{6}$/, 'Código de 6 dígitos.'),
  rememberDevice: z.boolean().optional(),
});

export const resendCodeSchema = z.object({
  email: z.string().email('Email inválido'),
  purpose: z.enum(['verify_email', 'login_2fa']),
});

// El refresh token se guarda en cookie httpOnly para no exponerlo a JS del cliente.
const refreshCookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 días
  path: '/api/auth',
};

// Cookie de "dispositivo recordado": salta el 2FA en este navegador 60 días.
const deviceCookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: 'lax',
  maxAge: 60 * 24 * 60 * 60 * 1000, // 60 días
  path: '/api/auth',
};

function sendAuthResponse(res, result, status = 200) {
  // Falta elegir a qué entrar (dueño o proyecto) o un código del proyecto: aún
  // sin sesión ni cookie.
  if (result.needsContext || result.needsContextCode || result.needsCode) {
    return res.json({
      success: true,
      data: {
        needsContext: Boolean(result.needsContext || result.needsContextCode),
        needsCode: Boolean(result.needsContextCode || result.needsCode),
        contexts: result.contexts || (result.context ? [result.context] : []),
        contextToken: result.contextToken,
        name: result.user?.name || '',
      },
    });
  }
  res.cookie('refreshToken', result.refreshToken, refreshCookieOptions);
  res.status(status).json({
    success: true,
    data: { user: result.user, accessToken: result.accessToken, context: result.context || null },
  });
}

export const register = asyncHandler(async (req, res) => {
  // Devuelve { needsEmailVerification, email, devCode? }: el cliente pide el código
  // y llama a verify-email. No se emite sesión hasta verificar el correo.
  const result = await authService.registerUser(req.body);
  res.status(201).json({ success: true, data: result });
});

export const login = asyncHandler(async (req, res) => {
  const deviceToken = req.cookies?.deviceToken;
  const result = await authService.loginUser({ ...req.body, deviceToken, ctx: requestContext(req) });
  // Estados intermedios: falta verificar correo o falta el 2FA. Sin sesión aún.
  if (result.needsEmailVerification || result.needs2fa) {
    return res.json({ success: true, data: result });
  }
  sendAuthResponse(res, result);
});

/** Confirma el correo con el código (registro) e inicia sesión. */
export const verifyEmail = asyncHandler(async (req, res) => {
  const result = await authService.verifyEmailAndLogin({ ...req.body, ctx: requestContext(req) });
  sendAuthResponse(res, result);
});

/** Verifica el 2FA del login; si rememberDevice, fija la cookie de dispositivo. */
export const verify2fa = asyncHandler(async (req, res) => {
  const result = await authService.verify2faAndLogin({ ...req.body, ctx: requestContext(req) });
  if (result.deviceToken) {
    res.cookie('deviceToken', result.deviceToken, deviceCookieOptions);
  }
  sendAuthResponse(res, result);
});

/** Reenvía un código OTP (verificación de correo o 2FA). */
export const resendCode = asyncHandler(async (req, res) => {
  const result = await authService.resendOtpCode(req.body);
  res.json({ success: true, data: result });
});

export const requestEmailChangeSchema = z.object({ newEmail: z.string().email('Email inválido') });

/** Solicita cambiar el correo: envía un código al correo NUEVO. */
export const requestEmailChange = asyncHandler(async (req, res) => {
  const result = await authService.requestEmailChange({
    userId: req.userId,
    newEmail: req.body.newEmail,
  });
  res.json({ success: true, data: result });
});

export const verifyEmailChangeSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Código de 6 dígitos.'),
});

/** Confirma el cambio de correo con el código. */
export const verifyEmailChange = asyncHandler(async (req, res) => {
  const { user } = await authService.verifyEmailChange({ userId: req.userId, code: req.body.code });
  res.json({ success: true, data: { user } });
});

export const googleSchema = z.object({
  credential: z.string().min(20, 'Credencial de Google inválida'),
  ref: z.string().max(16).optional(), // código de referido (solo cuenta en cuentas nuevas)
});

export const googleAuth = asyncHandler(async (req, res) => {
  const result = await authService.googleAuth(req.body.credential, req.body.ref, requestContext(req));
  sendAuthResponse(res, result);
});

/**
 * GET /api/auth/config — configuración pública para el cliente (Client ID de
 * Google). Sin datos sensibles. Permite ocultar el botón si no está configurado.
 */
export const getAuthConfig = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: {
      googleClientId: env.google.clientId,
      // Clave PÚBLICA de Turnstile (solo si también hay clave secreta: activo).
      turnstileSiteKey: turnstileEnabled() ? process.env.TURNSTILE_SITE_KEY || '' : '',
    },
  });
});

export const refresh = asyncHandler(async (req, res) => {
  const token = req.cookies?.refreshToken;
  try {
    const tokens = await authService.refreshTokens(token, requestContext(req));
    res.cookie('refreshToken', tokens.refreshToken, refreshCookieOptions);
    res.json({ success: true, data: { accessToken: tokens.accessToken } });
  } catch (err) {
    // Sesión muerta o robada: se borra la cookie para no reintentar con ella.
    res.clearCookie('refreshToken', { path: '/api/auth' });
    throw err;
  }
});

/** Cierra ESTA sesión de verdad (se revoca en el servidor, no solo la cookie). */
export const logout = asyncHandler(async (req, res) => {
  const token = req.cookies?.refreshToken;
  if (token) {
    try {
      const payload = verifyRefreshToken(token);
      if (payload.sid) await revokeSession(payload.sid, 'logout');
    } catch {
      /* cookie inválida o vencida: igual se borra */
    }
  }
  res.clearCookie('refreshToken', { path: '/api/auth' });
  res.json({ success: true, message: 'Sesión cerrada' });
});

/** GET /api/auth/sessions — sesiones activas del usuario (marca la actual). */
export const getSessions = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { sessions: await listSessions(req.userId, req.sessionId) } });
});

/** DELETE /api/auth/sessions/:id — cierra una sesión propia. */
export const deleteSession = asyncHandler(async (req, res) => {
  const { Session } = await import('../models/Session.js');
  const own = await Session.exists({ _id: req.params.id, user: req.userId });
  if (!own) throw ApiError.notFound('Sesión no encontrada');
  await revokeSession(req.params.id, 'user');
  res.json({ success: true, data: { current: String(req.params.id) === String(req.sessionId) } });
});

/** POST /api/auth/sessions/revoke-others — cierra todas las demás sesiones. */
export const revokeOtherSessions = asyncHandler(async (req, res) => {
  const closed = await revokeAllSessions(req.userId, { exceptId: req.sessionId, reason: 'others' });
  res.json({ success: true, data: { closed } });
});

export const me = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { user: req.user } });
});

/* ── Contexto (dueño / proyecto) y confirmación de identidad ─────────────── */

export const selectContextSchema = z.object({
  contextToken: z.string().min(20),
  businessId: z.string().length(24),
  code: z.string().regex(/^\d{6}$/).optional(),
});

/** POST /api/auth/context/select — elige a qué entrar tras el login. */
export const selectContext = asyncHandler(async (req, res) => {
  const result = await accessService.selectContext({ ...req.body, ctx: requestContext(req) });
  if (result.needsCode) {
    return res.json({ success: true, data: { needsCode: true, context: result.context } });
  }
  sendAuthResponse(res, result);
});

export const switchContextSchema = z.object({ businessId: z.string().length(24) });

/** POST /api/auth/context/switch — cambia de proyecto (sesión nueva, la anterior se cierra). */
export const switchContext = asyncHandler(async (req, res) => {
  const result = await accessService.switchContext({
    userId: req.userId,
    sessionId: req.sessionId,
    businessId: req.body.businessId,
    ctx: requestContext(req),
  });
  if (result.same) return res.json({ success: true, data: { same: true, context: result.context } });
  res.cookie('refreshToken', result.refreshToken, refreshCookieOptions);
  res.json({ success: true, data: { accessToken: result.accessToken, context: result.context } });
});

/** GET /api/auth/contexts — a qué puede entrar el usuario (para el selector). */
export const getContexts = asyncHandler(async (req, res) => {
  const contexts = await listContexts(req.userId);
  res.json({
    success: true,
    data: {
      contexts: contexts.map((c) => ({ kind: c.kind, businessId: c.businessId, name: c.name, photo: c.photo, requireTeam2fa: c.requireTeam2fa })),
      current: req.sessionContext || null,
    },
  });
});

export const stepUpSchema = z.object({
  password: z.string().min(1).max(200).optional(),
  code: z.string().regex(/^\d{6}$/).optional(),
});

/** POST /api/auth/step-up — confirma identidad (contraseña o código) por 10 minutos. */
export const stepUp = asyncHandler(async (req, res) => {
  const r = await accessService.stepUp({ userId: req.userId, sessionId: req.sessionId, ...req.body });
  res.json({ success: true, data: r });
});

/** POST /api/auth/step-up/code — envía el código para confirmar identidad. */
export const stepUpCode = asyncHandler(async (req, res) => {
  const r = await accessService.sendStepUpCode(req.userId);
  res.json({ success: true, data: r });
});

export const updateProfileSchema = z.object({
  name: z.string().min(2, 'El nombre debe tener al menos 2 caracteres').max(80),
});

/** PATCH /api/auth/profile — actualiza los datos personales del usuario (nombre). */
export const updateProfile = asyncHandler(async (req, res) => {
  const user = await User.findByIdAndUpdate(
    req.userId,
    { $set: { name: req.body.name.trim() } },
    { new: true }
  );
  res.json({ success: true, data: { user } });
});

export const twoFactorSchema = z.object({ enabled: z.boolean() });

/** PATCH /api/auth/2fa — activa/desactiva el 2FA por correo del usuario. */
export const updateTwoFactor = asyncHandler(async (req, res) => {
  const user = await User.findByIdAndUpdate(
    req.userId,
    { $set: { twoFactorEnabled: req.body.enabled } },
    { new: true }
  );
  if (!req.body.enabled) {
    void sendSecurityEmail({
      kind: 'two_factor_off',
      to: user.email,
      customerName: user.name,
      device: describeDevice(req.get('user-agent')).label,
      url: `${env.publicUrl.replace(/\/$/, '')}/dashboard/perfil#seguridad`,
    });
  }
  res.json({ success: true, data: { user } });
});

export const forgotPassword = asyncHandler(async (req, res) => {
  const result = await authService.requestPasswordReset(req.body.email);
  res.json({
    success: true,
    message: 'Si el email existe, te enviamos un enlace para restablecer tu contraseña.',
  });
  void result;
});

export const resetPassword = asyncHandler(async (req, res) => {
  await authService.resetPassword(req.body);
  res.json({ success: true, message: 'Contraseña actualizada, ya puedes iniciar sesión' });
});

// Eliminación de cuenta (irreversible). Password para cuentas con contraseña;
// `confirm: 'ELIMINAR'` para cuentas de Google. El servicio decide cuál exigir.
export const deleteAccountSchema = z.object({
  password: z.string().optional(),
  confirm: z.string().optional(),
});

/** DELETE /api/auth/account — elimina la cuenta del usuario y TODOS sus datos. */
export const deleteAccount = asyncHandler(async (req, res) => {
  // Eliminar la cuenta borra también su negocio: solo desde una sesión de dueño.
  if (req.sessionContext?.kind === 'member' && (await accessService.ownsBusiness(req.userId))) {
    throw new ApiError(403, 'Para eliminar tu cuenta entra como dueño de tu negocio.', { code: 'OWNER_CONTEXT_REQUIRED' });
  }
  await deleteAccountService({
    userId: req.userId,
    password: req.body.password,
    confirm: req.body.confirm,
  });
  // Cierra la sesión: limpia las cookies del backend.
  res.clearCookie('refreshToken', { path: '/api/auth' });
  res.clearCookie('deviceToken', { path: '/api/auth' });
  res.json({ success: true, message: 'Cuenta eliminada' });
});

/* ── Llaves de acceso (passkeys) ───────────────────────────────────────────── */

const webauthnResponse = z.object({ id: z.string().min(8).max(1024) }).passthrough();
export const passkeyVerifySchema = z.object({
  challengeId: z.string().regex(/^[a-f0-9]{24}$/i),
  response: webauthnResponse,
});
export const passkeyRenameSchema = z.object({ name: z.string().trim().min(1).max(60) });

/** GET /api/auth/passkeys — mis llaves. */
export const getPasskeys = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { passkeys: await passkeys.listPasskeys(req.userId) } });
});

/** POST /api/auth/passkeys/register/options — empezar a agregar una llave (con step-up). */
export const passkeyRegisterOptions = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await passkeys.registrationOptions(req.userId) });
});

/** POST /api/auth/passkeys/register/verify — guardar la llave creada en el dispositivo. */
export const passkeyRegisterVerify = asyncHandler(async (req, res) => {
  const list = await passkeys.verifyRegistration(req.userId, { ...req.body, userAgent: req.get('user-agent') });
  res.status(201).json({ success: true, data: { passkeys: list } });
});

export const renamePasskey = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { passkeys: await passkeys.renamePasskey(req.userId, req.params.id, req.body.name) } });
});

export const deletePasskey = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { passkeys: await passkeys.removePasskey(req.userId, req.params.id) } });
});

/** POST /api/auth/passkeys/login/options — entrar con llave (sin escribir correo). */
export const passkeyLoginOptions = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await passkeys.loginOptions() });
});

/** POST /api/auth/passkeys/login/verify — la llave cuenta como 2º factor. */
export const passkeyLoginVerify = asyncHandler(async (req, res) => {
  const user = await passkeys.verifyLogin(req.body);
  const result = await accessService.finishLogin(user, requestContext(req), { mfa: true });
  sendAuthResponse(res, result);
});

/** POST /api/auth/step-up/passkey/options|verify — confirmar identidad con llave. */
export const stepUpPasskeyOptions = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await passkeys.stepUpOptions(req.userId) });
});
export const stepUpPasskeyVerify = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await passkeys.verifyStepUp(req.userId, req.sessionId, req.body) });
});

/** GET /api/auth/security — "Tu seguridad": nivel, sugerencias y accesos recientes. */
export const getSecurityOverview = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await securityOverview(req.userId, req.sessionId) });
});
