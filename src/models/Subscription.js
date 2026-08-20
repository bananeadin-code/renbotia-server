import mongoose from 'mongoose';
import { SUBSCRIPTION_STATUS } from '../config/constants.js';

/**
 * Suscripción activa de un Business a un Plan, con la "billetera" de tokens:
 *  - tokensUsedThisPeriod: consumo del cupo del plan; se resetea al renovar.
 *  - extraTokens: créditos comprados aparte; NO se resetean, se acumulan.
 *
 * Disponible = plan.monthlyTokenLimit - tokensUsedThisPeriod + extraTokens.
 * El reseteo mensual es perezoso (ver services/token.service.js).
 */
const subscriptionSchema = new mongoose.Schema(
  {
    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      unique: true, // una suscripción por negocio en el MVP
      index: true,
    },
    plan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Plan',
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(SUBSCRIPTION_STATUS),
      default: SUBSCRIPTION_STATUS.ACTIVA,
    },
    currentPeriodStart: { type: Date, default: Date.now },
    renewalDate: { type: Date, required: true },
    tokensUsedThisPeriod: { type: Number, default: 0, min: 0 },
    extraTokens: { type: Number, default: 0, min: 0 },
    stripeSessionId: { type: String, default: '' },
    // Cambio de plan programado: se aplica en la próxima renovación (comportamiento
    // tradicional). Si status='cancelada', al renovar baja a Free en vez de cobrar.
    pendingPlanKey: { type: String, enum: ['', 'free', 'pro', 'elite'], default: '' },
    // Evita spamear el aviso de "crédito bajo": se marca al notificar y se
    // reinicia al renovar el periodo o al recargar créditos.
    lowBalanceNotified: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const Subscription = mongoose.model('Subscription', subscriptionSchema);
