import { BillingProfile } from '../models/BillingProfile.js';
import { Business } from '../models/Business.js';
import { computeBalance } from './token.service.js';
import { sendLowBalanceEmail } from './email.service.js';
import { logger } from '../utils/logger.js';

// Umbral de "crédito bajo": 10% del cupo del plan, con un piso razonable. Da
// margen para actuar antes de quedarse en cero.
function lowThreshold(subscription) {
  const planLimit = subscription.plan?.monthlyTokenLimit || 0;
  return Math.max(Math.round(planLimit * 0.1), 2000);
}

/**
 * Avisa por email al cliente cuando su saldo cae al umbral, para que compre más
 * y su bot no se apague sin previo aviso. Es idempotente por periodo (flag
 * lowBalanceNotified) y NO molesta a quien tiene recarga automática activa con
 * tarjeta (esa vía ya lo cubre). Fail-open: nunca rompe el flujo del bot.
 *
 * @param {object} p
 * @param {import('mongoose').Document} p.subscription  con plan poblado
 * @param {string|import('mongoose').Types.ObjectId} p.businessId
 * @param {string|import('mongoose').Types.ObjectId} [p.userId]
 */
export async function maybeNotifyLowBalance({ subscription, businessId, userId }) {
  try {
    if (subscription.lowBalanceNotified) return { notified: false };

    const balance = computeBalance(subscription);
    if (balance.available > lowThreshold(subscription)) return { notified: false };

    // Si tiene recarga automática activa con tarjeta, esa vía se encarga.
    const profile = await BillingProfile.findOne({ business: businessId });
    if (profile?.autoRecharge?.enabled && profile.paymentMethod?.id) {
      return { notified: false, reason: 'auto_recharge_activa' };
    }

    // Marca ANTES de enviar (evita duplicados por carrera); el envío es fail-open.
    subscription.lowBalanceNotified = true;
    await subscription.save();

    let owner = userId;
    if (!owner) {
      const biz = await Business.findById(businessId).select('owner name').lean();
      owner = biz?.owner;
    }
    const business = await Business.findById(businessId).select('name').lean();

    void sendLowBalanceEmail({
      userId: owner,
      businessName: business?.name,
      available: balance.available,
      planName: subscription.plan?.name,
    });

    logger.info(`Aviso de crédito bajo enviado (negocio ${businessId}, saldo ${balance.available}).`);
    return { notified: true };
  } catch (err) {
    logger.warn(`maybeNotifyLowBalance error (negocio ${businessId}): ${err.message}`);
    return { notified: false, error: err.message };
  }
}
