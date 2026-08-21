import crypto from 'crypto';
import { EmailOtp } from '../models/EmailOtp.js';
import { ApiError } from '../utils/ApiError.js';
import { env, isProd } from '../config/env.js';
import { sendEmail } from './email.service.js';
import { otpCodeEmail } from '../emails/otpCode.js';

/**
 * Códigos de un solo uso (OTP) por email para verificar correo y 2FA de login.
 */

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutos
const OTP_COOLDOWN_MS = 45 * 1000; // reenvío mínimo cada 45 s
const OTP_MAX_ATTEMPTS = 5;

/** Hash del código (sha256 con secreto del servidor); nunca se guarda en claro. */
function hashCode(code) {
  return crypto.createHash('sha256').update(`${code}:${env.jwt.accessSecret}`).digest('hex');
}

/**
 * Genera un OTP para (user, purpose), lo guarda hasheado y lo envía por email.
 * Respeta un cooldown de reenvío. Fail-open en el envío (si Resend no está
 * configurado, el flujo no se rompe; en desarrollo se devuelve el código).
 *
 * @param {{ user: object, purpose: 'verify_email'|'login_2fa' }} p
 * @returns {Promise<{ sent: boolean, devCode?: string }>}
 */
export async function sendOtp({ user, purpose }) {
  const existing = await EmailOtp.findOne({ user: user._id, purpose });
  if (existing && Date.now() - new Date(existing.lastSentAt).getTime() < OTP_COOLDOWN_MS) {
    throw new ApiError(429, 'Espera unos segundos antes de pedir otro código.');
  }

  const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 dígitos
  await EmailOtp.findOneAndUpdate(
    { user: user._id, purpose },
    {
      user: user._id,
      purpose,
      codeHash: hashCode(code),
      attempts: 0,
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      lastSentAt: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const { subject, html } = otpCodeEmail({
    code,
    purpose,
    customerName: user.name,
    minutes: 10,
  });
  await sendEmail({ to: user.email, subject, html });

  return { sent: true, ...(isProd ? {} : { devCode: code }) };
}

/**
 * Verifica un OTP. Lanza ApiError si es inválido/expirado/agotado. Si es
 * correcto, elimina el registro y devuelve ok.
 *
 * @param {{ userId: object, purpose: 'verify_email'|'login_2fa', code: string }} p
 */
export async function verifyOtp({ userId, purpose, code }) {
  const rec = await EmailOtp.findOne({ user: userId, purpose });
  if (!rec) throw ApiError.badRequest('Solicita un código primero.');

  if (Date.now() > new Date(rec.expiresAt).getTime()) {
    await rec.deleteOne();
    throw ApiError.badRequest('El código venció. Solicita uno nuevo.');
  }
  if (rec.attempts >= OTP_MAX_ATTEMPTS) {
    await rec.deleteOne();
    throw new ApiError(429, 'Demasiados intentos. Solicita un código nuevo.');
  }
  if (rec.codeHash !== hashCode(code)) {
    rec.attempts += 1;
    await rec.save();
    throw ApiError.badRequest('Código incorrecto.');
  }

  await rec.deleteOne();
  return { ok: true };
}
