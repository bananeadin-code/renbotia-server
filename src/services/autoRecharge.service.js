import { BillingProfile } from '../models/BillingProfile.js';
import { Payment } from '../models/Payment.js';
import { CREDIT_PACKS } from '../config/constants.js';
import { chargeOffSession } from './stripe.service.js';
import { computeBalance, addExtraTokens } from './token.service.js';
import { sendPurchaseReceipt } from './email.service.js';
import { logger } from '../utils/logger.js';

const findPack = (key) => CREDIT_PACKS.find((p) => p.key === key);

/**
 * Recarga automática de créditos, estilo "auto-reload" de la consola de Claude:
 * si el cliente lo activó y su saldo cayó al umbral, compra el pack elegido
 * cobrando OFF-SESSION la tarjeta guardada y acredita los tokens al instante,
 * para que no se quede sin servicio.
 *
 * Es defensivo: si no aplica (desactivado, sin tarjeta, saldo suficiente, tope
 * alcanzado) no hace nada. Si el cobro falla, no rompe el flujo del bot: lo
 * registra y devuelve el motivo para avisar al cliente.
 *
 * @param {object} params
 * @param {import('mongoose').Document} params.subscription - con plan poblado
 * @param {string|import('mongoose').Types.ObjectId} params.businessId
 * @param {string|import('mongoose').Types.ObjectId} params.userId - dueño (para Payment)
 * @returns {Promise<{ recharged: boolean, balance?: object, error?: string }>}
 */
export async function maybeAutoRecharge({ subscription, businessId, userId }) {
  const profile = await BillingProfile.findOne({ business: businessId });
  const ar = profile?.autoRecharge;

  // Guardias: debe estar activa, con tarjeta y customer, y un pack válido.
  if (!profile || !ar?.enabled || !profile.paymentMethod?.id || !profile.stripeCustomerId) {
    return { recharged: false };
  }
  const pack = findPack(ar.packKey);
  if (!pack) return { recharged: false };

  // ¿El saldo justifica recargar?
  const balance = computeBalance(subscription);
  if (balance.available > (ar.threshold || 0)) {
    return { recharged: false };
  }

  // Tope de seguridad: nº de recargas automáticas en el periodo actual.
  const since = subscription.currentPeriodStart || new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const autosThisPeriod = await Payment.countDocuments({
    business: businessId,
    packKey: pack.key,
    type: 'credits',
    stripeSessionId: { $regex: '^autopi_' }, // marca de recarga automática
    createdAt: { $gte: since },
  });
  if (autosThisPeriod >= (ar.maxPerPeriod || 5)) {
    logger.warn(`Auto-recarga: tope alcanzado (${autosThisPeriod}) para negocio ${businessId}`);
    return { recharged: false, error: 'auto_recharge_cap_reached' };
  }

  // Cobro off-session contra la tarjeta guardada.
  try {
    const pi = await chargeOffSession({
      customerId: profile.stripeCustomerId,
      paymentMethodId: profile.paymentMethod.id,
      amountMXN: pack.priceMXN,
      description: `Recarga automática — ${pack.name}`,
      metadata: { type: 'auto_recharge', packKey: pack.key, businessId: String(businessId) },
    });

    if (pi.status !== 'succeeded') {
      return { recharged: false, error: pi.status };
    }

    const newBalance = await addExtraTokens(subscription, pack.tokens);
    await Payment.create({
      user: userId,
      business: businessId,
      type: 'credits',
      description: `Recarga automática — ${pack.name}`,
      amountMXN: pack.priceMXN,
      tokens: pack.tokens,
      packKey: pack.key,
      // Prefijo 'autopi_' + id del PaymentIntent: único e identifica auto-recargas.
      stripeSessionId: `autopi_${pi.id}`,
    });

    // Comprobante por email de la recarga automática (fail-open).
    void sendPurchaseReceipt({
      userId,
      type: 'credits',
      description: `Recarga automática — ${pack.name}`,
      amountMXN: pack.priceMXN,
      tokens: pack.tokens,
      reference: `autopi_${pi.id}`,
      auto: true,
      availableAfter: newBalance.available,
    });

    logger.info(`Auto-recarga OK: ${pack.name} para negocio ${businessId}`);
    return { recharged: true, balance: newBalance };
  } catch (err) {
    // Tarjeta rechazada, requiere autenticación 3DS, etc. No bloquea al bot.
    logger.warn(`Auto-recarga falló (negocio ${businessId}): ${err.stripeCode || err.message}`);
    return { recharged: false, error: err.stripeCode || 'charge_failed' };
  }
}
