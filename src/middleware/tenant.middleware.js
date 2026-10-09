import { Business } from '../models/Business.js';
import { revokeSession } from '../services/session.service.js';
import { Membership } from '../models/Membership.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { provisionBusiness } from '../services/business.service.js';
import { ROLES, PERMISSION_KEYS, DEFAULT_MEMBER_PERMISSIONS } from '../config/constants.js';

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
  // Sesión con CONTEXTO (dueño o proyecto): el negocio lo fija la sesión, no el
  // cliente. Una sesión de proyecto nunca ve otro negocio ni actúa como dueño.
  const sc = req.sessionContext;
  if ((sc?.kind === 'owner' || sc?.kind === 'member') && sc.business) {
    const business = await Business.findById(sc.business);
    let role = null;
    if (business && sc.kind === 'owner' && String(business.owner) === String(req.userId)) {
      role = 'owner';
    } else if (business && sc.kind === 'member') {
      const m = await Membership.findOne({ business: business._id, user: req.userId }).select('role permissions').lean();
      if (m && m.role !== 'owner') {
        role = m.role;
        req.permissions = { ...DEFAULT_MEMBER_PERMISSIONS, ...(m.permissions || {}) };
      }
    }
    if (!role) {
      // Ya no tiene acceso (lo quitaron del equipo o el negocio cambió de dueño).
      if (req.sessionId) await revokeSession(req.sessionId, 'access_removed').catch(() => {});
      throw new ApiError(401, 'Ya no tienes acceso a este proyecto. Inicia sesión de nuevo.', { code: 'NO_ACCESS' });
    }
    req.business = business;
    req.businessId = business._id;
    req.membershipRole = role;
    if (role === 'owner') req.permissions = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true]));
    return next();
  }

  // Sesión de cuenta (sin negocio aún, o anterior a los contextos): comportamiento
  // previo. Proyecto activo elegido por el cliente (switcher). Opcional; si viene,
  // SIEMPRE se valida que el usuario tenga acceso a ese negocio antes de usarlo.
  const desiredId = req.get('x-business-id') || null;

  const owned = await Business.findOne({ owner: req.userId });
  // Backfill: negocios previos al multiusuario no tienen Membership 'owner'.
  if (owned) {
    await Membership.updateOne(
      { business: owned._id, user: req.userId },
      { $setOnInsert: { role: 'owner' } },
      { upsert: true }
    );
  }

  let business = null;
  let role = null;

  if (desiredId) {
    // Selección explícita: validar acceso (dueño o colaborador de ESE negocio).
    if (owned && String(owned._id) === String(desiredId)) {
      business = owned;
      role = 'owner';
    } else {
      const membership = await Membership.findOne({ user: req.userId, business: desiredId });
      if (membership) {
        business = await Business.findById(desiredId);
        role = membership.role;
      }
    }
    if (!business) {
      throw new ApiError(403, 'No tienes acceso a este proyecto', { code: 'NO_ACCESS' });
    }
  } else if (owned) {
    // Sin selección: por defecto el negocio propio.
    business = owned;
    role = 'owner';
  } else {
    // Sin negocio propio: la primera colaboración.
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
  // Permisos efectivos: el dueño todos; un colaborador los de su membresía.
  if (role === 'owner') {
    req.permissions = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true]));
  } else {
    const m = await Membership.findOne({ business: business._id, user: req.userId }).select('permissions').lean();
    req.permissions = { ...DEFAULT_MEMBER_PERMISSIONS, ...(m?.permissions || {}) };
  }
  next();
});

const PERMISSION_MESSAGES = {
  simulator: 'No tienes permiso para usar el simulador. Pídeselo al dueño del negocio.',
  training: 'No tienes permiso para entrenar el bot. Pídeselo al dueño del negocio.',
  profile: 'No tienes permiso para cambiar los datos del negocio. Pídeselo al dueño.',
  connections: 'No tienes permiso para cambiar las conexiones. Pídeselo al dueño del negocio.',
};

/** Exige un permiso de colaborador (el dueño siempre pasa). Va DESPUÉS de requireBusiness. */
export function requirePermission(key) {
  return (req, res, next) => {
    if (req.membershipRole === 'owner' || req.permissions?.[key]) return next();
    return next(new ApiError(403, PERMISSION_MESSAGES[key] || 'No tienes permiso para esta acción.', { code: 'PERMISSION_REQUIRED', permission: key }));
  };
}

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
