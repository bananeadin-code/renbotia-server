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
import {
  getBusinessProfile,
  updateBusinessProfile,
  createTemplate,
  listTemplates,
} from '../services/whatsapp.service.js';
import { logAudit } from '../services/audit.service.js';

// Categorías (verticals) de WhatsApp Business con etiqueta en español para el
// selector. El valor debe ser uno del enum de Meta.
const WHATSAPP_VERTICALS = [
  { value: 'PROF_SERVICES', label: 'Servicios profesionales' },
  { value: 'FINANCE', label: 'Finanzas' },
  { value: 'HEALTH', label: 'Salud' },
  { value: 'EDU', label: 'Educación' },
  { value: 'RETAIL', label: 'Comercio' },
  { value: 'RESTAURANT', label: 'Restaurante' },
  { value: 'TRAVEL', label: 'Viajes' },
  { value: 'OTHER', label: 'Otro' },
];

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

/* ─── Perfil de WhatsApp Business (lo que el cliente ve en el chat) ─────────── */

/** GET /api/connections/whatsapp/profile — perfil actual + catálogo de categorías. */
export const getWhatsappProfile = asyncHandler(async (req, res) => {
  const business = await Business.findById(req.businessId).select('whatsappPhoneNumberId');
  if (!business?.whatsappPhoneNumberId) {
    return res.json({ success: true, data: { connected: false, profile: null, verticals: WHATSAPP_VERTICALS } });
  }
  const result = await getBusinessProfile(business.whatsappPhoneNumberId);
  res.json({
    success: true,
    data: {
      connected: true,
      profile: result.ok ? result.profile : {},
      error: result.ok ? null : result.error,
      verticals: WHATSAPP_VERTICALS,
    },
  });
});

export const updateWhatsappProfileSchema = z.object({
  description: z.string().max(512).optional(),
  about: z.string().max(139).optional(),
  email: z.string().email('Email inválido').max(128).optional().or(z.literal('')),
  website: z.string().url('URL inválida (incluye https://)').max(256).optional().or(z.literal('')),
  address: z.string().max(256).optional(),
  vertical: z.string().max(40).optional(),
});

/** PUT /api/connections/whatsapp/profile — actualiza el perfil (solo dueño). */
export const updateWhatsappProfile = asyncHandler(async (req, res) => {
  const business = await Business.findById(req.businessId).select('whatsappPhoneNumberId');
  if (!business?.whatsappPhoneNumberId) {
    throw new ApiError(400, 'Conecta tu WhatsApp antes de editar el perfil.', { code: 'NOT_CONNECTED' });
  }

  const { description, about, email, website, address, vertical } = req.body;
  const fields = {};
  if (description !== undefined) fields.description = description;
  if (about !== undefined) fields.about = about;
  if (email !== undefined) fields.email = email;
  if (address !== undefined) fields.address = address;
  if (vertical) fields.vertical = vertical;
  if (website !== undefined) fields.websites = website ? [website] : [];

  const result = await updateBusinessProfile(business.whatsappPhoneNumberId, fields);
  if (!result.ok) {
    throw new ApiError(502, `No se pudo actualizar el perfil: ${result.error}`, { code: 'PROFILE_FAILED' });
  }
  void logAudit({
    businessId: req.businessId,
    userId: req.userId,
    action: 'whatsapp.profile',
    summary: 'Actualizó el perfil de su WhatsApp Business.',
  });
  res.json({ success: true, data: { updated: true } });
});

/* ─── Plantillas de la WABA ────────────────────────────────────────────────── */

/** GET /api/connections/whatsapp/templates — plantillas de la WABA (todos los estados). */
export const listWhatsappTemplates = asyncHandler(async (req, res) => {
  const business = await Business.findById(req.businessId).select('whatsappWabaId');
  if (!business?.whatsappWabaId) {
    return res.json({ success: true, data: { templates: [], reason: 'no_waba' } });
  }
  const result = await listTemplates(business.whatsappWabaId);
  res.json({
    success: true,
    data: { templates: result.templates || [], reason: result.ok ? null : 'fetch_failed' },
  });
});

export const createTemplateSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]{1,60}$/, 'Solo minúsculas, números y guion bajo (sin espacios).'),
  category: z.enum(['MARKETING', 'UTILITY']),
  language: z.string().min(2).max(10).optional(),
  bodyText: z.string().min(1).max(1024),
});

/** POST /api/connections/whatsapp/templates — crea una plantilla (solo dueño). */
export const createWhatsappTemplate = asyncHandler(async (req, res) => {
  const business = await Business.findById(req.businessId).select('whatsappWabaId');
  if (!business?.whatsappWabaId) {
    throw new ApiError(400, 'Conecta tu WhatsApp antes de crear plantillas.', { code: 'NOT_CONNECTED' });
  }
  const result = await createTemplate(business.whatsappWabaId, {
    name: req.body.name,
    category: req.body.category,
    language: req.body.language || 'es_MX',
    bodyText: req.body.bodyText,
  });
  if (!result.ok) {
    throw new ApiError(502, `No se pudo crear la plantilla: ${result.error}`, { code: 'TEMPLATE_CREATE_FAILED' });
  }
  void logAudit({
    businessId: req.businessId,
    userId: req.userId,
    action: 'whatsapp.template',
    summary: `Creó la plantilla de WhatsApp "${req.body.name}".`,
  });
  res.json({ success: true, data: { id: result.id, status: result.status || 'PENDING' } });
});

/** PIN de verificación en dos pasos (6 dígitos) para registrar el número. */
function generatePin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
