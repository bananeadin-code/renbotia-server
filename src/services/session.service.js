import crypto from 'node:crypto';
import { Session } from '../models/Session.js';
import { User } from '../models/User.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';
import { describeDevice, countryName } from '../utils/userAgent.js';
import { signAccessToken, signRefreshToken } from '../utils/jwt.js';
import { sendSecurityEmail } from './email.service.js';
import { alertOps } from './alert.service.js';

/**
 * Sesiones en servidor (Fase 1 de seguridad).
 *
 *  - Cada inicio de sesión crea una Session; el refresh token lleva su `sid` y un
 *    `jti` que ROTA en cada renovación (el anterior deja de valer).
 *  - Reutilizar un jti viejo fuera del margen de gracia = cookie copiada → se
 *    revoca la sesión y se avisa por correo (detección de robo, estándar OAuth).
 *  - Vence por inactividad (IDLE_DAYS) y de forma absoluta (ABSOLUTE_DAYS).
 *  - El access token (15 min) lleva el `sid`; requireAuth comprueba que la sesión
 *    siga viva (con caché corta), así cerrar sesión corta el acceso en segundos.
 */

export const IDLE_DAYS = 7;
export const ABSOLUTE_DAYS = 30;
// Varias pestañas pueden renovar a la vez con la misma cookie: el jti anterior
// sigue valiendo unos segundos para no confundirlo con un robo.
const GRACE_MS = 60 * 1000;
// Se guarda el historial de sesiones un tiempo para reconocer dispositivos.
const KEEP_HISTORY_DAYS = 90;
const DAY = 24 * 3600 * 1000;

const newJti = () => crypto.randomBytes(16).toString('base64url');
const appUrl = () => env.publicUrl.replace(/\/$/, '');

/** Datos del dispositivo/red de la petición. */
export function requestContext(req) {
  return {
    ip: req.ip || '',
    userAgent: String(req.get?.('user-agent') || '').slice(0, 400),
    country: String(req.get?.('cf-ipcountry') || '').toUpperCase().slice(0, 2),
  };
}

function deviceKeyOf(browser, os, country) {
  return crypto.createHash('sha256').update(`${browser}|${os}|${country}`).digest('hex').slice(0, 32);
}

/** Emite el par de tokens de una sesión (el refresh con su jti vigente). */
function tokensFor(user, session) {
  const base = { sub: String(user._id), role: user.role, tv: user.tokenVersion ?? 0, sid: String(session._id) };
  return {
    accessToken: signAccessToken(base),
    refreshToken: signRefreshToken({ ...base, jti: session.jti }),
  };
}

/* ── Caché corta de "¿la sesión sigue viva?" (una instancia; se invalida al revocar) ── */
const CACHE_MS = 15 * 1000;
const cache = new Map(); // sid → { ok, until }
function cacheSet(sid, ok) {
  if (cache.size > 5000) cache.clear();
  cache.set(String(sid), { ok, until: Date.now() + CACHE_MS });
}
function cacheDrop(sid) {
  cache.delete(String(sid));
}

/**
 * Crea una sesión al iniciar sesión y devuelve los tokens. Si es un dispositivo
 * que la cuenta no había usado (y no es su primera sesión), avisa por correo.
 * @param {object} p
 * @param {object} p.user documento User
 * @param {object} p.ctx  requestContext(req)
 * @param {boolean} [p.silent] sin aviso de dispositivo nuevo (migración)
 */
export async function startSession({ user, ctx = {}, silent = false }) {
  const { browser, os, label } = describeDevice(ctx.userAgent);
  const country = ctx.country || '';
  const deviceKey = deviceKeyOf(browser, os, country);
  const now = Date.now();

  let isNewDevice = false;
  if (!silent) {
    const [anyBefore, sameDevice] = await Promise.all([
      Session.exists({ user: user._id }),
      Session.exists({ user: user._id, deviceKey, createdAt: { $gte: new Date(now - KEEP_HISTORY_DAYS * DAY) } }),
    ]);
    // La primera sesión registrada no avisa (alta de cuenta o primera vez tras
    // activar esta función); después, solo los dispositivos nunca vistos.
    isNewDevice = Boolean(anyBefore) && !sameDevice;
  }

  const session = await Session.create({
    user: user._id,
    jti: newJti(),
    device: label,
    browser,
    os,
    country,
    deviceKey,
    ip: ctx.ip || '',
    lastUsedAt: new Date(now),
    expiresAt: new Date(now + ABSOLUTE_DAYS * DAY),
    purgeAt: new Date(now + (ABSOLUTE_DAYS + KEEP_HISTORY_DAYS) * DAY),
  });

  if (isNewDevice) {
    void sendSecurityEmail({
      kind: 'new_login',
      to: user.email,
      customerName: user.name,
      device: label,
      place: countryName(country),
      when: new Date(now),
      url: `${appUrl()}/dashboard/perfil#sesiones`,
      resetUrl: `${appUrl()}/recuperar`,
    });
  }
  return { session, ...tokensFor(user, session) };
}

/** Revoca una sesión (y la saca de la caché). */
export async function revokeSession(sessionId, reason = 'user') {
  const r = await Session.updateOne(
    { _id: sessionId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } }
  );
  cacheDrop(sessionId);
  return r.modifiedCount > 0;
}

/** Revoca todas las sesiones vivas del usuario, salvo `exceptId` si se indica. */
export async function revokeAllSessions(userId, { exceptId = null, reason = 'others' } = {}) {
  const filter = { user: userId, revokedAt: null };
  if (exceptId) filter._id = { $ne: exceptId };
  const live = await Session.find(filter).select('_id').lean();
  if (!live.length) return 0;
  await Session.updateMany({ _id: { $in: live.map((s) => s._id) } }, { $set: { revokedAt: new Date(), revokedReason: reason } });
  live.forEach((s) => cacheDrop(s._id));
  return live.length;
}

function isExpired(session, now = Date.now()) {
  if (session.revokedAt) return 'revoked';
  if (session.expiresAt.getTime() <= now) return 'expired';
  if (session.lastUsedAt.getTime() + IDLE_DAYS * DAY <= now) return 'idle';
  return null;
}

/**
 * Renueva con el refresh token. Rota el jti; detecta reutilización de uno viejo.
 * @param {object} payload refresh token ya verificado (firma/expiración)
 * @param {object} ctx requestContext(req)
 * @returns {Promise<{accessToken, refreshToken}>}
 */
export async function rotateSession(payload, ctx = {}) {
  const user = await User.findById(payload.sub);
  if (!user) throw ApiError.unauthorized('El usuario ya no existe');
  if ((payload.tv ?? 0) !== (user.tokenVersion ?? 0)) {
    throw ApiError.unauthorized('Sesión expirada, inicia sesión de nuevo');
  }

  // Tokens de antes de esta función (sin sid): se migran a una sesión nueva sin
  // sacar a nadie. Dejan de existir solos en 7 días (vida del refresh viejo).
  if (!payload.sid) {
    const { accessToken, refreshToken } = await startSession({ user, ctx, silent: true });
    return { accessToken, refreshToken };
  }

  const session = await Session.findOne({ _id: payload.sid, user: user._id });
  if (!session) throw ApiError.unauthorized('Sesión expirada, inicia sesión de nuevo');
  const now = Date.now();
  const dead = isExpired(session, now);
  if (dead) {
    if (dead !== 'revoked') await revokeSession(session._id, dead);
    throw ApiError.unauthorized('Tu sesión terminó, inicia sesión de nuevo');
  }

  // Caso normal: presenta el jti vigente → se rota (atómico ante pestañas paralelas).
  if (payload.jti === session.jti) {
    const next = newJti();
    const updated = await Session.findOneAndUpdate(
      { _id: session._id, jti: payload.jti, revokedAt: null },
      {
        $set: {
          jti: next,
          prevJti: payload.jti,
          prevValidUntil: new Date(now + GRACE_MS),
          lastUsedAt: new Date(now),
          ip: ctx.ip || session.ip,
        },
      },
      { new: true }
    );
    if (updated) return tokensFor(user, updated);
    // Otra pestaña rotó justo antes: se resuelve abajo como margen de gracia.
    const fresh = await Session.findById(session._id);
    if (fresh && !fresh.revokedAt && fresh.prevJti === payload.jti && fresh.prevValidUntil > new Date()) {
      return tokensFor(user, fresh);
    }
    throw ApiError.unauthorized('Sesión expirada, inicia sesión de nuevo');
  }

  // Jti anterior dentro del margen: otra pestaña ya renovó, se entrega el vigente.
  if (payload.jti && payload.jti === session.prevJti && session.prevValidUntil && session.prevValidUntil.getTime() > now) {
    return tokensFor(user, session);
  }

  // Jti viejo fuera de margen: la cookie fue copiada y usada por alguien más.
  await revokeSession(session._id, 'reuse');
  logger.warn(`[security] Reutilización de refresh token: user=${user.id} sesión=${session.id} ip=${ctx.ip || '?'}`);
  alertOps({ kind: 'session_reuse', message: `Reutilización de sesión del usuario ${user.id}`, detail: `ip=${ctx.ip} ua=${ctx.userAgent}` });
  void sendSecurityEmail({
    kind: 'session_reuse',
    to: user.email,
    customerName: user.name,
    device: session.device,
    place: countryName(session.country),
    url: `${appUrl()}/dashboard/perfil#sesiones`,
    resetUrl: `${appUrl()}/recuperar`,
  });
  throw ApiError.unauthorized('Cerramos esta sesión por seguridad. Inicia sesión de nuevo.');
}

/**
 * ¿La sesión del access token sigue viva? (caché de 15 s). Actualiza lastUsedAt
 * como mucho una vez por minuto, para que la inactividad se mida bien.
 */
export async function assertSessionActive(sid, userId) {
  const hit = cache.get(String(sid));
  if (hit && hit.until > Date.now()) {
    if (!hit.ok) throw ApiError.unauthorized('Tu sesión terminó, inicia sesión de nuevo');
    return;
  }
  const session = await Session.findOne({ _id: sid, user: userId }).select('revokedAt expiresAt lastUsedAt').lean();
  const now = Date.now();
  const ok = Boolean(session) && !session.revokedAt && session.expiresAt.getTime() > now && session.lastUsedAt.getTime() + IDLE_DAYS * DAY > now;
  cacheSet(sid, ok);
  if (!ok) throw ApiError.unauthorized('Tu sesión terminó, inicia sesión de nuevo');
  if (now - session.lastUsedAt.getTime() > 60 * 1000) {
    await Session.updateOne({ _id: sid }, { $set: { lastUsedAt: new Date(now) } });
  }
}

/** Sesiones vivas del usuario para Perfil → Seguridad. */
export async function listSessions(userId, currentSid) {
  const now = Date.now();
  const rows = await Session.find({ user: userId, revokedAt: null, expiresAt: { $gt: new Date(now) } })
    .sort({ lastUsedAt: -1 })
    .lean();
  return rows
    .filter((s) => s.lastUsedAt.getTime() + IDLE_DAYS * DAY > now)
    .map((s) => ({
      id: String(s._id),
      device: s.device || 'Dispositivo',
      browser: s.browser,
      os: s.os,
      place: countryName(s.country),
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      current: String(s._id) === String(currentSid || ''),
    }));
}
