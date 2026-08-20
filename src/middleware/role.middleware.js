import { ApiError } from '../utils/ApiError.js';
import { ROLES } from '../config/constants.js';

/**
 * Restringe una ruta a ciertos roles. Debe ir después de requireAuth.
 *
 *   router.get('/admin', requireAuth, requireRole(ROLES.ADMIN), handler);
 */
export function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.user) {
      return next(ApiError.unauthorized());
    }
    if (!allowed.includes(req.user.role)) {
      return next(ApiError.forbidden('No tienes permisos para esta acción'));
    }
    next();
  };
}

export const requireAdmin = requireRole(ROLES.ADMIN);
