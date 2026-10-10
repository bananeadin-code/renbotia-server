import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { Passkey } from '../models/Passkey.js';
import { AuthChallenge } from '../models/AuthChallenge.js';
import { User } from '../models/User.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';
import { describeDevice } from '../utils/userAgent.js';
import { recordStepUp } from './session.service.js';
import { sendSecurityEmail } from './email.service.js';

/**
 * Llaves de acceso (WebAuthn): entrar con huella, cara o PIN del dispositivo.
 *
 * - Son OPCIONALES y se suman a la contraseña: más rápidas y resistentes al
 *   phishing (la llave solo responde en renbotia.com, no en un sitio falso).
 * - Cuentan como segundo factor: entrar con llave no pide código por correo.
 * - También sirven para "confirma que eres tú" (step-up) sin escribir nada.
 * - Retos de un solo uso (AuthChallenge, 5 min); se exige verificación del
 *   usuario (huella/PIN), no solo tener el dispositivo.
 */

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_PASSKEYS = 10;
const RP_NAME = 'RenBotIA';

/** Dominio de la llave (rpID) y orígenes aceptados, a partir de la URL pública. */
export function relyingParty() {
  const url = new URL(env.publicUrl);
  const rpID = process.env.WEBAUTHN_RP_ID || url.hostname.replace(/^www\./, '');
  const origins = new Set([url.origin]);
  if (url.hostname !== 'localhost') origins.add(`${url.protocol}//www.${rpID}`).add(`${url.protocol}//${rpID}`);
  for (const o of String(process.env.WEBAUTHN_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)) origins.add(o);
  return { rpID, origins: [...origins] };
}

async function saveChallenge(challenge, purpose, user = null) {
  const doc = await AuthChallenge.create({ challenge, purpose, user, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) });
  return String(doc._id);
}

/** Toma (y borra) un reto vigente: cada reto sirve una sola vez. */
async function takeChallenge(challengeId, purpose, user = null) {
  if (!/^[a-f0-9]{24}$/i.test(String(challengeId || ''))) throw ApiError.badRequest('Solicitud vencida, intenta de nuevo.');
  const q = { _id: challengeId, purpose, expiresAt: { $gt: new Date() } };
  if (user) q.user = user;
  const ch = await AuthChallenge.findOneAndDelete(q).lean();
  if (!ch) throw ApiError.badRequest('La solicitud venció. Intenta de nuevo.');
  return ch.challenge;
}

const publicPasskey = (p) => ({
  id: String(p._id),
  name: p.name,
  synced: p.deviceType === 'multiDevice' || p.backedUp,
  createdAt: p.createdAt,
  lastUsedAt: p.lastUsedAt,
});

export async function listPasskeys(userId) {
  const list = await Passkey.find({ user: userId }).sort({ createdAt: -1 }).lean();
  return list.map(publicPasskey);
}

/* ── Registrar una llave (con sesión y confirmación de identidad) ──────────── */

export async function registrationOptions(userId) {
  const user = await User.findById(userId).lean();
  if (!user) throw ApiError.unauthorized('No autenticado');
  const existing = await Passkey.find({ user: userId }).select('credentialId transports').lean();
  if (existing.length >= MAX_PASSKEYS) throw ApiError.badRequest(`Puedes tener hasta ${MAX_PASSKEYS} llaves de acceso. Quita una que ya no uses.`);
  const { rpID } = relyingParty();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: user.email,
    userDisplayName: user.name || user.email,
    userID: new TextEncoder().encode(String(user._id)),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  const challengeId = await saveChallenge(options.challenge, 'register', user._id);
  return { options, challengeId };
}

export async function verifyRegistration(userId, { challengeId, response, userAgent = '' }) {
  const expectedChallenge = await takeChallenge(challengeId, 'register', userId);
  const { rpID, origins } = relyingParty();
  let result;
  try {
    result = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch (err) {
    logger.warn(`Passkey: registro rechazado: ${err.message}`);
    throw ApiError.badRequest('No pudimos guardar la llave de acceso. Intenta de nuevo.');
  }
  if (!result.verified || !result.registrationInfo) throw ApiError.badRequest('No pudimos verificar la llave de acceso.');
  const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
  if (await Passkey.exists({ credentialId: credential.id })) throw ApiError.conflict('Esa llave de acceso ya está registrada.');

  const name = describeDevice(userAgent).label || 'Llave de acceso';
  await Passkey.create({
    user: userId,
    credentialId: credential.id,
    publicKey: isoBase64URL.fromBuffer(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports || [],
    name: name.slice(0, 60),
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
  });

  const user = await User.findById(userId).select('email name').lean();
  void sendSecurityEmail({
    kind: 'passkey_added',
    to: user.email,
    customerName: user.name,
    device: name,
    url: `${env.publicUrl.replace(/\/$/, '')}/dashboard/perfil#seguridad`,
  });
  return listPasskeys(userId);
}

export async function renamePasskey(userId, id, name) {
  const r = await Passkey.updateOne({ _id: id, user: userId }, { $set: { name: String(name).trim().slice(0, 60) } });
  if (!r.matchedCount) throw ApiError.notFound('Llave no encontrada');
  return listPasskeys(userId);
}

export async function removePasskey(userId, id) {
  const pk = await Passkey.findOneAndDelete({ _id: id, user: userId }).lean();
  if (!pk) throw ApiError.notFound('Llave no encontrada');
  const user = await User.findById(userId).select('email name').lean();
  void sendSecurityEmail({
    kind: 'passkey_removed',
    to: user.email,
    customerName: user.name,
    device: pk.name,
    url: `${env.publicUrl.replace(/\/$/, '')}/dashboard/perfil#seguridad`,
  });
  return listPasskeys(userId);
}

/* ── Usar una llave: entrar o confirmar identidad ──────────────────────────── */

/** Opciones para entrar con llave (sin correo: el dispositivo ofrece las suyas). */
export async function loginOptions() {
  const { rpID } = relyingParty();
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials: [] });
  const challengeId = await saveChallenge(options.challenge, 'login');
  return { options, challengeId };
}

/** Opciones para confirmar identidad con una de SUS llaves. */
export async function stepUpOptions(userId) {
  const creds = await Passkey.find({ user: userId }).select('credentialId transports').lean();
  if (!creds.length) throw ApiError.badRequest('No tienes llaves de acceso.');
  const { rpID } = relyingParty();
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
    allowCredentials: creds.map((c) => ({ id: c.credentialId, transports: c.transports })),
  });
  const challengeId = await saveChallenge(options.challenge, 'stepup', userId);
  return { options, challengeId };
}

/** Verifica una respuesta firmada y devuelve el usuario dueño de la llave. */
async function verifyAssertion({ challengeId, response, purpose, userId = null }) {
  const expectedChallenge = await takeChallenge(challengeId, purpose, userId);
  const pk = await Passkey.findOne({ credentialId: String(response?.id || '') });
  if (!pk || (userId && String(pk.user) !== String(userId))) {
    throw new ApiError(401, 'Esa llave de acceso no está registrada en tu cuenta. Entra con tu correo y contraseña.', { code: 'PASSKEY_UNKNOWN' });
  }
  const { rpID, origins } = relyingParty();
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: pk.credentialId,
        publicKey: isoBase64URL.toBuffer(pk.publicKey),
        counter: pk.counter,
        transports: pk.transports,
      },
    });
  } catch (err) {
    logger.warn(`Passkey: verificación rechazada: ${err.message}`);
    throw ApiError.unauthorized('No pudimos verificar tu llave de acceso.');
  }
  if (!result.verified) throw ApiError.unauthorized('No pudimos verificar tu llave de acceso.');
  pk.counter = result.authenticationInfo.newCounter;
  pk.lastUsedAt = new Date();
  await pk.save();
  return pk.user;
}

/** Entrar con llave: devuelve el usuario (el login sigue como uno con 2FA). */
export async function verifyLogin({ challengeId, response }) {
  const userId = await verifyAssertion({ challengeId, response, purpose: 'login' });
  const user = await User.findById(userId);
  if (!user) throw ApiError.unauthorized('Esta cuenta ya no existe.');
  if (!user.emailVerified) throw ApiError.unauthorized('Confirma tu correo antes de entrar.');
  return user;
}

/** Confirmar identidad con llave (cuenta como segundo factor). */
export async function verifyStepUp(userId, sessionId, { challengeId, response }) {
  if (!sessionId) throw ApiError.unauthorized('Tu sesión terminó, inicia sesión de nuevo');
  await verifyAssertion({ challengeId, response, purpose: 'stepup', userId });
  await recordStepUp(sessionId, { mfa: true });
  return { ok: true, mfa: true };
}
