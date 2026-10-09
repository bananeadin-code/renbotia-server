import crypto from 'node:crypto';
import { User } from '../models/User.js';
import { Business } from '../models/Business.js';
import { ApiError } from '../utils/ApiError.js';
import { signContextToken, verifyContextToken } from '../utils/jwt.js';
import { sendOtp, verifyOtp } from './otp.service.js';
import {
  startSession,
  listContexts,
  revokeSession,
  recordStepUp,
  getLiveSession,
  STEP_UP_MS,
} from './session.service.js';

/**
 * Acceso por CONTEXTO (Fase 2 de seguridad):
 *  - Tras autenticarse, la persona entra como DUEÑO de su negocio o a un PROYECTO
 *    donde colabora. Cada uno es una sesión independiente, limitada a ese negocio.
 *  - Si tiene más de un contexto, elige (token de contexto de 5 min); si tiene uno,
 *    entra directo.
 *  - Entrar como dueño desde una sesión de colaborador pide confirmar identidad.
 *  - Un negocio puede exigir verificación en dos pasos a todo su equipo.
 */

// Tokens de contexto ya usados (un solo uso). En memoria: viven 5 minutos.
const usedContextTokens = new Map();
function markUsed(jti) {
  const now = Date.now();
  for (const [k, exp] of usedContextTokens) if (exp < now) usedContextTokens.delete(k);
  if (usedContextTokens.has(jti)) return false;
  usedContextTokens.set(jti, now + 6 * 60 * 1000);
  return true;
}

const toContext = (c) => ({ kind: c.kind, business: c.businessId });
const publicContext = (c) => ({ kind: c.kind, businessId: c.businessId, name: c.name, photo: c.photo, requireTeam2fa: c.requireTeam2fa });

/**
 * Cierra el inicio de sesión ya autenticado: entra directo si hay un solo contexto
 * (o ninguno, para el onboarding), o pide elegir si hay varios.
 * @param {object} user
 * @param {object} ctx requestContext(req)
 * @param {{ mfa: boolean }} opts ¿se verificó un segundo factor en este login?
 */
export async function finishLogin(user, ctx, { mfa = false } = {}) {
  const contexts = await listContexts(user._id);
  if (contexts.length > 1) {
    const contextToken = signContextToken({ sub: String(user._id), mfa: Boolean(mfa), jti: crypto.randomBytes(12).toString('base64url') });
    return { needsContext: true, contexts: contexts.map(publicContext), contextToken, user };
  }
  const only = contexts[0];
  if (only?.kind === 'member' && only.requireTeam2fa && !mfa) {
    // Su único proyecto exige 2FA y este login no lo verificó: código por correo.
    const contextToken = signContextToken({ sub: String(user._id), mfa: false, jti: crypto.randomBytes(12).toString('base64url') });
    await sendOtp({ user, purpose: 'context_2fa' });
    return { needsContextCode: true, contexts: [publicContext(only)], contextToken, user };
  }
  const { accessToken, refreshToken } = await startSession({
    user,
    ctx,
    context: only ? toContext(only) : null,
    mfa,
  });
  return { user, accessToken, refreshToken, context: only ? publicContext(only) : null };
}

/**
 * Elige el contexto tras el login (pantalla "¿A dónde quieres entrar?").
 * Si el proyecto exige 2FA y el login no lo verificó, primero pide un código.
 */
export async function selectContext({ contextToken, businessId, code, ctx }) {
  let payload;
  try {
    payload = verifyContextToken(contextToken);
  } catch {
    throw new ApiError(401, 'Pasó mucho tiempo. Vuelve a iniciar sesión.', { code: 'CONTEXT_EXPIRED' });
  }
  const user = await User.findById(payload.sub);
  if (!user) throw ApiError.unauthorized('El usuario ya no existe');
  const target = (await listContexts(user._id)).find((c) => c.businessId === String(businessId));
  if (!target) throw new ApiError(403, 'No tienes acceso a ese proyecto.', { code: 'NO_ACCESS' });

  let mfa = Boolean(payload.mfa);
  if (target.kind === 'member' && target.requireTeam2fa && !mfa) {
    if (!code) {
      await sendOtp({ user, purpose: 'context_2fa' }).catch((err) => {
        if (err.statusCode !== 429) throw err; // reenvío muy seguido: el código anterior sigue vigente
      });
      return { needsCode: true, context: publicContext(target) };
    }
    await verifyOtp({ userId: user._id, purpose: 'context_2fa', code });
    mfa = true;
  }
  // El token de contexto es de un solo uso (se marca al crear la sesión).
  if (!markUsed(payload.jti)) throw new ApiError(401, 'Ese acceso ya se usó. Vuelve a iniciar sesión.', { code: 'CONTEXT_USED' });
  const { accessToken, refreshToken } = await startSession({ user, ctx, context: toContext(target), mfa });
  return { user, accessToken, refreshToken, context: publicContext(target) };
}

/**
 * Cambia de proyecto con la sesión actual: abre una sesión NUEVA para el destino
 * y cierra la anterior (cada contexto es independiente).
 *  - Entrar como dueño desde un proyecto: pide confirmar identidad (contraseña o código).
 *  - Entrar a un proyecto que exige 2FA sin haberlo verificado: pide código.
 */
export async function switchContext({ userId, sessionId, businessId, ctx }) {
  const user = await User.findById(userId);
  if (!user) throw ApiError.unauthorized('El usuario ya no existe');
  const current = await getLiveSession(sessionId, userId);
  if (!current) throw ApiError.unauthorized('Tu sesión terminó, inicia sesión de nuevo');

  const target = (await listContexts(userId)).find((c) => c.businessId === String(businessId));
  if (!target) throw new ApiError(403, 'No tienes acceso a ese proyecto.', { code: 'NO_ACCESS' });
  if (current.context?.kind === target.kind && String(current.context?.business) === target.businessId) {
    return { same: true, context: publicContext(target) };
  }

  const recent = current.stepUpAt && Date.now() - current.stepUpAt.getTime() < STEP_UP_MS;
  if (target.kind === 'owner' && current.context?.kind !== 'owner' && !recent) {
    throw new ApiError(403, 'Confirma que eres tú para entrar como dueño.', { code: 'STEP_UP_REQUIRED' });
  }
  if (target.kind === 'member' && target.requireTeam2fa && !current.mfa) {
    throw new ApiError(403, 'Este proyecto exige verificación en dos pasos. Confirma con el código que te enviamos.', {
      code: 'STEP_UP_REQUIRED',
      mfa: true,
    });
  }

  const { accessToken, refreshToken } = await startSession({
    user,
    ctx,
    silent: true, // mismo dispositivo: no es un "inicio de sesión nuevo"
    context: toContext(target),
    mfa: current.mfa,
  });
  await revokeSession(current._id, 'switch');
  return { accessToken, refreshToken, context: publicContext(target) };
}

/** Envía el código para confirmar identidad (cuentas sin contraseña o 2FA exigido). */
export async function sendStepUpCode(userId) {
  const user = await User.findById(userId);
  if (!user) throw ApiError.unauthorized('No autenticado');
  return sendOtp({ user, purpose: 'step_up' });
}

/**
 * Confirma identidad en la sesión actual: con contraseña o con el código por
 * correo (el código además cuenta como segundo factor).
 */
export async function stepUp({ userId, sessionId, password, code }) {
  if (!sessionId) throw ApiError.unauthorized('Tu sesión terminó, inicia sesión de nuevo');
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw ApiError.unauthorized('No autenticado');
  if (code) {
    await verifyOtp({ userId: user._id, purpose: 'step_up', code });
    await recordStepUp(sessionId, { mfa: true });
    return { ok: true, mfa: true };
  }
  if (!password) throw ApiError.badRequest('Escribe tu contraseña o pide un código.');
  if (!user.passwordHash) {
    throw new ApiError(400, 'Tu cuenta entra con Google: confirma con un código por correo.', { code: 'USE_CODE' });
  }
  if (user.lockUntil && user.lockUntil > new Date()) {
    throw new ApiError(429, 'Demasiados intentos. Espera unos minutos o confirma con un código.', { code: 'ACCOUNT_LOCKED' });
  }
  const ok = await user.comparePassword(password);
  if (!ok) {
    user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
    if (user.failedLoginAttempts >= 8) user.lockUntil = new Date(Date.now() + 15 * 60 * 1000);
    await user.save();
    throw new ApiError(401, 'La contraseña no es correcta.', { code: 'WRONG_PASSWORD' });
  }
  if (user.failedLoginAttempts) {
    user.failedLoginAttempts = 0;
    await user.save();
  }
  await recordStepUp(sessionId, { mfa: false });
  return { ok: true, mfa: false };
}

/** ¿El usuario tiene un negocio propio? (para limitar acciones de cuenta desde un proyecto) */
export async function ownsBusiness(userId) {
  return Boolean(await Business.exists({ owner: userId }));
}
