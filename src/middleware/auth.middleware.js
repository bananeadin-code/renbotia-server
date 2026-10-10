import { verifyAccessToken } from '../utils/jwt.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { User } from '../models/User.js';
import { assertSessionActive } from '../services/session.service.js';

/**
 * Verifica el access token del header `Authorization: Bearer <token>`.
 * Adjunta el usuario a req.user para los siguientes middlewares/controladores.
 */
export const requireAuth = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    throw ApiError.unauthorized('Falta el token de acceso');
  }

  const payload = verifyAccessToken(token); // lanza si inválido/expirado
  // Objeto simple (lean): el resto del flujo solo lo LEE; construir el documento
  // completo de mongoose en cada petición del panel era costoso bajo carga.
  const user = await User.findById(payload.sub).select('name email role tokenVersion').lean();

  if (!user) {
    throw ApiError.unauthorized('El usuario ya no existe');
  }
  // Invalidación de sesiones: un token con tokenVersion viejo (p. ej. de antes de
  // un restablecimiento de contraseña) deja de valer de inmediato.
  if ((payload.tv ?? 0) !== (user.tokenVersion ?? 0)) {
    throw ApiError.unauthorized('Sesión expirada, inicia sesión de nuevo');
  }

  // Sesión en servidor: si se cerró (logout, "cerrar las demás", robo
  // detectado, contraseña restablecida), el acceso se corta en segundos aunque
  // el access token aún no venza. Los tokens previos a esta función no traen
  // sid y vencen solos en 15 min.
  if (payload.sid) await assertSessionActive(payload.sid, user._id);

  req.user = user;
  req.userId = String(user._id);
  req.sessionId = payload.sid || null;
  // Contexto de la sesión: dueño de su negocio, colaborador de un proyecto o
  // cuenta (sin negocio / sesiones previas). requireBusiness lo hace cumplir.
  req.sessionContext = payload.sid
    ? { kind: payload.ck || 'account', business: payload.cb || null }
    : { kind: 'account', business: null };
  next();
});
