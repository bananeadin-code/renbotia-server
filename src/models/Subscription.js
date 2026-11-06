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

    // ── Renovación con cobro (ver services/renewal.service.js) ──
    // Intentos de cobro del periodo vencido (se reinician al renovar).
    renewalAttempts: { type: Number, default: 0 },
    // Próximo intento de cobro (reintentos con espera; null = en cuanto venza).
    nextRenewalAttemptAt: { type: Date, default: null },
    // Desde cuándo está vencida sin pago (inicio del periodo de gracia).
    pastDueSince: { type: Date, default: null },
    // Último motivo de fallo de cobro (card_declined, no_card, etc.).
    lastRenewalError: { type: String, default: '' },
    // Candado del cobro: evita que dos procesos cobren la misma renovación.
    renewalLockUntil: { type: Date, default: null },
    // Fecha de renovación para la que ya se envió el aviso previo (anti-spam).
    renewalReminderFor: { type: Date, default: null },
    // Cortesía (cuentas internas o de soporte): el plan se renueva cada mes SIN
    // cobro ni avisos de pago. Solo se activa por script (scripts/set-comp-plan.mjs).
    complimentary: { type: Boolean, default: false },

    // ── Ciclo de cobro (ver services/pricing.service.js) ──
    // anual: se cobra una vez al año (termEndsAt); renewalDate sigue marcando el
    // reinicio MENSUAL del cupo, que dentro del año pagado no se cobra.
    billingCycle: { type: String, enum: ['mensual', 'anual'], default: 'mensual' },
    // Cambio de ciclo programado para el próximo cobro (p. ej. anual → mensual al terminar el año).
    pendingCycle: { type: String, enum: ['', 'mensual', 'anual'], default: '' },
    termStartedAt: { type: Date, default: null },
    termEndsAt: { type: Date, default: null },
    // Lo pagado por el año en curso (base del prorrateo al mejorar de plan).
    termPaidMXN: { type: Number, default: 0 },
    // Precio anual conservado al renovar el mismo plan.
    lockedPlanKey: { type: String, default: '' },
    lockedAnnualMXN: { type: Number, default: 0 },
    // Contrató el anual con precio de fundador (lo conserva mientras renueve en anual).
    founder: { type: Boolean, default: false },
    // Garantía de 30 días de la primera compra anual: pagos que se reembolsarían.
    guaranteeEndsAt: { type: Date, default: null },
    guaranteePaymentIds: { type: [String], default: [] },
    // Ya recibió la garantía alguna vez (no se repite en compras anuales posteriores).
    annualGuaranteeGranted: { type: Boolean, default: false },
    // Fecha del año para la que ya se envió el aviso de 15 días (anti-spam).
    annualReminderFor: { type: Date, default: null },
    // Valor del mes de PAGO en curso (precio mensual con el que se abrió). 0 =
    // periodo sin pago (Free, mes de regalo, cortesía o plan anual). Es la base
    // del descuento por los días no usados al mejorar de plan.
    periodPaidMXN: { type: Number, default: 0, min: 0 },

    // ── Retención ──
    // Encuesta al cancelar (motivo de CANCEL_REASONS + comentario libre).
    cancelReason: { type: String, default: '' },
    cancelComment: { type: String, default: '', maxlength: 500 },
    canceledAt: { type: Date, default: null },
    // Correo de "pásate a anual" (se envía una sola vez).
    annualOfferSentAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// El cobrador busca renovaciones vencidas por fecha.
subscriptionSchema.index({ renewalDate: 1 });

export const Subscription = mongoose.model('Subscription', subscriptionSchema);
