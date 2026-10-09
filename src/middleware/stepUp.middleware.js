import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { Session } from '../models/Session.js';
import { STEP_UP_MS } from '../services/session.service.js';

/**
 * "Modo sudo": exige haber confirmado identidad (contraseña o código) en los
 * últimos 10 minutos para acciones delicadas: pagar, cambiar la tarjeta, invitar
 * o quitar personas, cambiar permisos, conectar/desconectar canales, desactivar
 * el 2FA, cambiar el correo… El cliente, al recibir STEP_UP_REQUIRED, pide la
 * contraseña (o un código) y reintenta la misma petición.
 *
 * Va DESPUÉS de requireAuth.
 */
export const requireRecentAuth = asyncHandler(async (req, res, next) => {
  // Token de antes de las sesiones (sin sid): se fuerza a renovarlo primero.
  if (!req.sessionId) throw ApiError.unauthorized('Tu sesión se actualizó, vuelve a intentarlo.');
  const s = await Session.findById(req.sessionId).select('stepUpAt').lean();
  if (s?.stepUpAt && Date.now() - new Date(s.stepUpAt).getTime() < STEP_UP_MS) return next();
  throw new ApiError(403, 'Confirma que eres tú para continuar.', { code: 'STEP_UP_REQUIRED' });
});
