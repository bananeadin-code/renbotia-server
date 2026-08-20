import crypto from 'crypto';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { Business } from '../models/Business.js';
import { PhoneVerification } from '../models/PhoneVerification.js';
import { AuditLog } from '../models/AuditLog.js';
import { normalizePhone, isMexican } from '../utils/phone.js';
import { sendSms } from '../services/sms.service.js';
import { logAudit } from '../services/audit.service.js';
import { env, isProd } from '../config/env.js';

export const updateBusinessSchema = z.object({
  name: z.string().min(2).optional(),
  industry: z.enum(['legal', 'contable', 'consultoria', 'agencia', 'otro']).optional(),
  industryOther: z.string().max(60).optional(),
  whatsappNumber: z.string().max(30).optional(),
});

/**
 * Devuelve el negocio del usuario autenticado (ya resuelto por requireBusiness).
 */
export const getMyBusiness = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { business: req.business, role: req.membershipRole } });
});

/**
 * GET /api/business/audit
 * Bitácora de auditoría del negocio (últimos movimientos): quién cambió qué.
 */
export const getAuditLog = asyncHandler(async (req, res) => {
  const logs = await AuditLog.find({ business: req.businessId })
    .sort({ createdAt: -1 })
    .limit(50)
    .populate('user', 'name email')
    .lean();
  res.json({ success: true, data: { logs } });
});

/**
 * Actualiza datos del negocio. Solo campos del propio negocio (tenant).
 */
export const updateMyBusiness = asyncHandler(async (req, res) => {
  const patch = { ...req.body };
  // El sector personalizado solo aplica cuando el rubro es "otro"; en cualquier
  // otro caso se limpia para no dejar texto huérfano.
  if (patch.industry && patch.industry !== 'otro') patch.industryOther = '';

  // Si cambia el número de WhatsApp por esta vía, se normaliza a E.164 y queda
  // SIN verificar (la propiedad se confirma por código, no escribiéndolo aquí).
  if (patch.whatsappNumber !== undefined) {
    const raw = String(patch.whatsappNumber).trim();
    if (raw === '') {
      patch.whatsappNumber = '';
      patch.whatsappVerified = false;
      patch.whatsappVerifiedAt = null;
    } else {
      const norm = normalizePhone(raw);
      if (!norm.ok) throw ApiError.badRequest(norm.reason);
      patch.whatsappNumber = norm.e164;
      if (norm.e164 !== req.business?.whatsappNumber) {
        patch.whatsappVerified = false;
        patch.whatsappVerifiedAt = null;
      }
    }
  }

  const updated = await Business.findByIdAndUpdate(
    req.businessId,
    { $set: patch },
    { new: true, runValidators: true }
  );
  void logAudit({
    businessId: req.businessId,
    userId: req.userId,
    action: 'business.update',
    summary: 'Actualizó los datos del negocio.',
    metadata: { fields: Object.keys(req.body) },
  });
  res.json({ success: true, data: { business: updated } });
});

/* ─── Verificación de propiedad del número de WhatsApp (OTP) ──────────────────
   Confirma que el número es del negocio (recibe el código) y lo deja dedicado.
   Meta añade su propia verificación al conectar la Cloud API en producción. */

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutos
const OTP_COOLDOWN_MS = 45 * 1000; // reenvío mínimo cada 45 s
const OTP_MAX_ATTEMPTS = 5;

/** Hash del código (sha256 con secreto del servidor); nunca se guarda en claro. */
function hashCode(code) {
  return crypto.createHash('sha256').update(`${code}:${env.jwt.accessSecret}`).digest('hex');
}

export const sendWhatsappCodeSchema = z.object({ phone: z.string().min(6).max(30) });

/**
 * POST /api/business/whatsapp/send-code
 * Valida y normaliza el número, verifica que no esté tomado por otro negocio,
 * genera un OTP de 6 dígitos (hasheado, con expiración) y lo "envía" por SMS.
 * En desarrollo devuelve el código (devCode) para probar sin proveedor real.
 */
export const sendWhatsappCode = asyncHandler(async (req, res) => {
  const norm = normalizePhone(req.body.phone);
  if (!norm.ok) throw ApiError.badRequest(norm.reason);

  const taken = await Business.findOne({
    whatsappNumber: norm.e164,
    whatsappVerified: true,
    _id: { $ne: req.businessId },
  });
  if (taken) throw ApiError.badRequest('Ese número ya está verificado en otra cuenta.');

  const existing = await PhoneVerification.findOne({ business: req.businessId });
  if (existing && Date.now() - new Date(existing.lastSentAt).getTime() < OTP_COOLDOWN_MS) {
    throw new ApiError(429, 'Espera unos segundos antes de pedir otro código.');
  }

  const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 dígitos
  await PhoneVerification.findOneAndUpdate(
    { business: req.businessId },
    {
      business: req.businessId,
      phone: norm.e164,
      codeHash: hashCode(code),
      attempts: 0,
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      lastSentAt: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await sendSms({
    to: norm.e164,
    body: `Tu código de verificación de RenBotIA es ${code}. Vence en 10 minutos.`,
  });

  const data = { phone: norm.e164, isMexican: isMexican(norm.e164) };
  if (!isProd) data.devCode = code; // solo en desarrollo, para probar sin SMS real
  res.json({ success: true, message: 'Código enviado.', data });
});

export const verifyWhatsappSchema = z.object({ code: z.string().regex(/^\d{6}$/, 'Código de 6 dígitos.') });

/**
 * POST /api/business/whatsapp/verify
 * Comprueba el OTP (vigencia, intentos y coincidencia). Si es correcto, marca el
 * número como verificado y dedicado al negocio (índice único parcial).
 */
export const verifyWhatsapp = asyncHandler(async (req, res) => {
  const rec = await PhoneVerification.findOne({ business: req.businessId });
  if (!rec) throw ApiError.badRequest('Solicita un código primero.');

  if (Date.now() > new Date(rec.expiresAt).getTime()) {
    await rec.deleteOne();
    throw ApiError.badRequest('El código venció. Solicita uno nuevo.');
  }
  if (rec.attempts >= OTP_MAX_ATTEMPTS) {
    await rec.deleteOne();
    throw new ApiError(429, 'Demasiados intentos. Solicita un código nuevo.');
  }
  if (rec.codeHash !== hashCode(req.body.code)) {
    rec.attempts += 1;
    await rec.save();
    throw ApiError.badRequest('Código incorrecto.');
  }

  try {
    const updated = await Business.findByIdAndUpdate(
      req.businessId,
      {
        $set: {
          whatsappNumber: rec.phone,
          whatsappVerified: true,
          whatsappVerifiedAt: new Date(),
        },
      },
      { new: true, runValidators: true }
    );
    await rec.deleteOne();
    void logAudit({
      businessId: req.businessId,
      userId: req.userId,
      action: 'whatsapp.verify',
      summary: `Verificó el número de WhatsApp ${rec.phone}.`,
    });
    res.json({ success: true, message: 'Número verificado.', data: { business: updated } });
  } catch (err) {
    if (err.code === 11000) {
      throw ApiError.badRequest('Ese número ya está verificado en otra cuenta.');
    }
    throw err;
  }
});
