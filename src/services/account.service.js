import { ROLES } from '../config/constants.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';
import { deleteCustomer } from './stripe.service.js';

import { User } from '../models/User.js';
import { Business } from '../models/Business.js';
import { Membership } from '../models/Membership.js';
import { BillingProfile } from '../models/BillingProfile.js';
import { BotConfig } from '../models/BotConfig.js';
import { ChatSimulation } from '../models/ChatSimulation.js';
import { Invitation } from '../models/Invitation.js';
import { ManagedRecord } from '../models/ManagedRecord.js';
import { ManagementConfig } from '../models/ManagementConfig.js';
import { Payment } from '../models/Payment.js';
import { PhoneVerification } from '../models/PhoneVerification.js';
import { Subscription } from '../models/Subscription.js';
import { UsageLog } from '../models/UsageLog.js';
import { AuditLog } from '../models/AuditLog.js';
import { EmailOtp } from '../models/EmailOtp.js';
import { Waitlist } from '../models/Waitlist.js';

/**
 * Eliminación de cuenta (derecho ARCO de cancelación / LFPDPPP y requisito de
 * Meta de "eliminación de datos"). Borra al usuario y TODOS sus datos.
 *
 * Modelo multi-tenant: los datos cuelgan de un Business. Al eliminar la cuenta
 * se borran por completo los negocios de los que el usuario es DUEÑO (con toda
 * su información); en los negocios donde solo colabora, se elimina únicamente su
 * membresía (no se toca el negocio ajeno).
 */

// Colecciones cuyas filas cuelgan de un Business (se borran por { business: $in }).
const BUSINESS_OWNED_MODELS = [
  AuditLog,
  BillingProfile,
  BotConfig,
  ChatSimulation, // historial de conversaciones (bot y manual)
  Invitation,
  ManagedRecord, // citas, pedidos, prospectos
  ManagementConfig,
  Membership, // membresías de ese negocio (incluye a otros colaboradores)
  Payment,
  PhoneVerification,
  Subscription,
  UsageLog,
];

/**
 * @param {object} p
 * @param {string} p.userId    Usuario autenticado que pide eliminar SU cuenta.
 * @param {string} [p.password] Contraseña actual (cuentas con contraseña).
 * @param {string} [p.confirm]  Palabra de confirmación (cuentas de Google, sin contraseña).
 * @returns {Promise<{ deleted: true, businessesDeleted: number }>}
 */
export async function deleteAccount({ userId, password, confirm }) {
  const user = await User.findById(userId).select('+passwordHash +googleId');
  if (!user) throw new ApiError(404, 'Usuario no encontrado');

  // El admin de la plataforma no puede autoeliminarse (evita quedarnos sin admin).
  if (user.role === ROLES.ADMIN) {
    throw new ApiError(403, 'La cuenta de administrador no puede eliminarse desde aquí.', {
      code: 'ADMIN_PROTECTED',
    });
  }

  // Reautenticación antes de una acción irreversible.
  if (user.passwordHash) {
    if (!password || !(await user.comparePassword(password))) {
      throw new ApiError(401, 'Contraseña incorrecta.', { code: 'BAD_PASSWORD' });
    }
  } else if (confirm !== 'ELIMINAR') {
    // Cuentas de Google (sin contraseña): exigimos la palabra de confirmación.
    throw new ApiError(400, 'Escribe ELIMINAR para confirmar.', { code: 'CONFIRM_REQUIRED' });
  }

  // Negocios de los que el usuario es DUEÑO.
  const owned = await Business.find({ owner: userId }).select('_id').lean();
  const businessIds = owned.map((b) => b._id);

  if (businessIds.length) {
    // 1) Elimina los Customers de Stripe (borra también la tarjeta guardada).
    const profiles = await BillingProfile.find({ business: { $in: businessIds } })
      .select('stripeCustomerId')
      .lean();
    for (const p of profiles) {
      try {
        await deleteCustomer(p.stripeCustomerId);
      } catch (err) {
        logger.warn(
          `[account] No se pudo borrar el Customer de Stripe ${p.stripeCustomerId}: ${err.message}`
        );
      }
    }

    // 2) Borra todas las colecciones que cuelgan de esos negocios.
    for (const Model of BUSINESS_OWNED_MODELS) {
      await Model.deleteMany({ business: { $in: businessIds } });
    }

    // 3) Borra los negocios.
    await Business.deleteMany({ _id: { $in: businessIds } });
  }

  // Membresías del usuario como COLABORADOR en negocios de otros.
  await Membership.deleteMany({ user: userId });

  // Datos ligados directamente al usuario (no a un negocio).
  await EmailOtp.deleteMany({ user: userId });
  await Payment.deleteMany({ user: userId });
  await Waitlist.deleteMany({ email: user.email });

  // Finalmente, el usuario.
  await User.findByIdAndDelete(userId);

  logger.warn(
    `[security] Cuenta eliminada: userId=${userId} email=${user.email} negocios=${businessIds.length}`
  );

  return { deleted: true, businessesDeleted: businessIds.length };
}
