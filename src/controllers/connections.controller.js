import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';
import { Business } from '../models/Business.js';
import {
  exchangeCode,
  subscribeApp,
  registerPhone,
  resolveWabaAndPhone,
} from '../services/whatsappOnboarding.service.js';
import { logAudit } from '../services/audit.service.js';

/**
 * Módulo de Conexiones: enlaza cada negocio con sus canales (hoy WhatsApp vía
 * Embedded Signup). Mientras `embeddedEnabled` sea false (falta App Review de
 * Meta), la UI muestra "Próximamente" y el endpoint de conexión rechaza.
 */

/** GET /api/connections — estado + config pública para inicializar el signup. */
export const getConnections = asyncHandler(async (req, res) => {
  const business = await Business.findById(req.businessId).select(
    'whatsappPhoneNumberId whatsappWabaId whatsappVerified'
  );
  res.json({
    success: true,
    data: {
      embeddedEnabled: env.whatsapp.embeddedEnabled,
      // No secretos: el cliente los usa para lanzar el Embedded Signup.
      facebook: {
        appId: env.whatsapp.appId,
        configId: env.whatsapp.configId,
        apiVersion: env.whatsapp.apiVersion,
      },
      whatsapp: {
        connected: Boolean(business?.whatsappPhoneNumberId),
        phoneNumberId: business?.whatsappPhoneNumberId || '',
        wabaId: business?.whatsappWabaId || '',
      },
    },
  });
});

export const connectSchema = z.object({
  code: z.string().min(10),
  // Opcionales: si el navegador no los pasa, el backend los deduce del token.
  wabaId: z.string().optional(),
  phoneNumberId: z.string().optional(),
});

/** POST /api/connections/whatsapp — completa el Embedded Signup del cliente. */
export const connectWhatsApp = asyncHandler(async (req, res) => {
  if (!env.whatsapp.embeddedEnabled) {
    throw new ApiError(403, 'La conexión con WhatsApp aún no está disponible.', {
      code: 'EMBEDDED_DISABLED',
    });
  }
  const { code } = req.body;
  let { wabaId, phoneNumberId } = req.body;

  // 1) Canjea el code por un token con acceso a la WABA del cliente.
  const ex = await exchangeCode(code);
  if (!ex.ok) {
    throw new ApiError(502, 'No se pudo completar la conexión con Meta. Intenta de nuevo.', {
      code: 'EXCHANGE_FAILED',
    });
  }

  // 2) Si el navegador no pasó WABA/número, los deducimos del token (robusto).
  if (!wabaId || !phoneNumberId) {
    const resolved = await resolveWabaAndPhone(ex.token);
    if (!resolved.ok) {
      throw new ApiError(
        422,
        'No pudimos leer tu número de WhatsApp. Revisa que esté agregado y verificado en tu cuenta de WhatsApp Business y vuelve a intentar.',
        { code: 'NO_PHONE' }
      );
    }
    wabaId = wabaId || resolved.wabaId;
    phoneNumberId = phoneNumberId || resolved.phoneNumberId;
  }

  // 3) Un número no puede estar conectado a dos negocios.
  const clash = await Business.findOne({
    whatsappPhoneNumberId: phoneNumberId,
    _id: { $ne: req.businessId },
  }).select('_id');
  if (clash) {
    throw new ApiError(409, 'Ese número de WhatsApp ya está conectado a otra cuenta.', {
      code: 'PHONE_IN_USE',
    });
  }

  // 4) Suscribe la app a la WABA (indispensable para recibir sus mensajes).
  const sub = await subscribeApp(wabaId, ex.token);
  if (!sub.ok) {
    throw new ApiError(502, 'No se pudo suscribir la cuenta de WhatsApp. Intenta de nuevo.', {
      code: 'SUBSCRIBE_FAILED',
    });
  }

  // 3) Registra el número en la Cloud API (best-effort: si ya estaba, seguimos).
  await registerPhone(phoneNumberId, ex.token, generatePin());

  // 4) Guarda la conexión en el negocio.
  const business = await Business.findById(req.businessId);
  if (!business) throw new ApiError(404, 'Negocio no encontrado');
  business.whatsappPhoneNumberId = phoneNumberId;
  business.whatsappWabaId = wabaId;
  business.whatsappVerified = true;
  business.whatsappVerifiedAt = new Date();
  await business.save();

  void logAudit({
    businessId: req.businessId,
    userId: req.userId,
    action: 'whatsapp.connect',
    summary: 'Conectó su número de WhatsApp (Embedded Signup).',
  });

  res.json({ success: true, data: { connected: true, phoneNumberId, wabaId } });
});

/** POST /api/connections/whatsapp/disconnect — desvincula el número. */
export const disconnectWhatsApp = asyncHandler(async (req, res) => {
  const business = await Business.findById(req.businessId);
  if (!business) throw new ApiError(404, 'Negocio no encontrado');
  business.whatsappPhoneNumberId = '';
  business.whatsappWabaId = '';
  business.whatsappVerified = false;
  business.whatsappVerifiedAt = null;
  await business.save();

  void logAudit({
    businessId: req.businessId,
    userId: req.userId,
    action: 'whatsapp.disconnect',
    summary: 'Desconectó su número de WhatsApp.',
  });

  res.json({ success: true, data: { connected: false } });
});

/** PIN de verificación en dos pasos (6 dígitos) para registrar el número. */
function generatePin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
