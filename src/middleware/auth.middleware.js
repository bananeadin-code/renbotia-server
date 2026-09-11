import { verifyAccessToken } from '../utils/jwt.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { User } from '../models/User.js';

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
  const user = await User.findById(payload.sub);

  if (!user) {
    throw ApiError.unauthorized('El usuario ya no existe');
  }
  // Invalidación de sesiones: un token con tokenVersion viejo (p. ej. de antes de
  // un restablecimiento de contraseña) deja de valer de inmediato.
  if ((payload.tv ?? 0) !== (user.tokenVersion ?? 0)) {
    throw ApiError.unauthorized('Sesión expirada, inicia sesión de nuevo');
  }

  req.user = user;
  req.userId = user.id;
  next();
});
