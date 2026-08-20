import { Business } from '../models/Business.js';
import { Membership } from '../models/Membership.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { provisionBusiness } from '../services/business.service.js';
import { ROLES } from '../config/constants.js';

/**
 * Resuelve el negocio del usuario y su ROL en él, y lo adjunta a la request.
 * Un usuario accede a un negocio si es su dueño o si es miembro (colaborador).
 * Toda ruta con datos de negocio debe filtrar por req.businessId (aislamiento).
 *
 * - Dueño: resuelve por Business.owner (y se hace backfill de su membresía
 *   'owner' para negocios creados antes del multiusuario).
 * - Colaborador: resuelve por su Membership.
 * - Admin sin negocio: se le aprovisiona uno Free (no se le obliga a onboarding).
 * - Sin negocio: 404 NO_BUSINESS para que el frontend mande al onboarding.
 */
export const requireBusiness = asyncHandler(async (req, res, next) => {
  let business = await Business.findOne({ owner: req.userId });
  let role = null;

  if (business) {
    role = 'owner';
    // Backfill: negocios previos al multiusuario no tienen Membership 'owner'.
    await Membership.updateOne(
      { business: business._id, user: req.userId },
      { $setOnInsert: { role: 'owner' } },
      { upsert: true }
    );
  } else {
    const membership = await Membership.findOne({ user: req.userId }).sort({ createdAt: 1 });
    if (membership) {
      business = await Business.findById(membership.business);
      role = membership.role;
    }
  }

  if (!business && req.user?.role === ROLES.ADMIN) {
    const bundle = await provisionBusiness({
      owner: req.userId,
      planKey: 'free',
      business: { name: 'RenBotIA (Administración)' },
    });
    business = bundle.business;
    role = 'owner';
  }

  if (!business) {
    throw new ApiError(404, 'Aún no tienes un negocio configurado', { code: 'NO_BUSINESS' });
  }

  req.business = business;
  req.businessId = business._id;
  req.membershipRole = role;
  next();
});

/**
 * Exige uno de los roles indicados en el negocio actual. Va DESPUÉS de
 * requireBusiness. Ejemplo: `requireBusinessRole('owner')` para facturación.
 */
export function requireBusinessRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.membershipRole)) {
      return next(
        new ApiError(403, 'Esta acción es solo para el dueño del negocio', { code: 'ROLE_REQUIRED' })
      );
    }
    next();
  };
}
