import mongoose from 'mongoose';

/**
 * Perfil de facturación de un Business (1:1). Guarda:
 *  - El Customer de Stripe (para asociar tarjetas y cobrar off-session).
 *  - La tarjeta guardada — SOLO datos de display (marca, últimos 4, vencimiento)
 *    y el id del PaymentMethod de Stripe. NUNCA el número de tarjeta: los datos
 *    sensibles viven en Stripe (Elements los captura en un iframe; PCI lo maneja
 *    Stripe).
 *  - La configuración de recarga automática de créditos extra.
 */
const billingProfileSchema = new mongoose.Schema(
  {
    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      unique: true,
      index: true,
    },
    stripeCustomerId: { type: String, default: '' },
    // Tarjeta guardada (null si no hay). Solo tokens/metadata, nada sensible.
    paymentMethod: {
      type: {
        id: { type: String, required: true }, // pm_… de Stripe
        brand: { type: String, default: '' }, // visa, mastercard…
        last4: { type: String, default: '' },
        expMonth: { type: Number, default: 0 },
        expYear: { type: Number, default: 0 },
      },
      default: null,
    },
    // Recarga automática: compra un pack cuando el saldo cae al umbral.
    autoRecharge: {
      enabled: { type: Boolean, default: false },
      packKey: { type: String, default: '' }, // pack a comprar (CREDIT_PACKS.key)
      threshold: { type: Number, default: 0, min: 0 }, // recarga si disponible <= umbral
      // Tope de seguridad: máximo de recargas automáticas por periodo (evita
      // cobros en cadena si algo se descontrola).
      maxPerPeriod: { type: Number, default: 5, min: 1, max: 50 },
    },
  },
  { timestamps: true }
);

export const BillingProfile = mongoose.model('BillingProfile', billingProfileSchema);
