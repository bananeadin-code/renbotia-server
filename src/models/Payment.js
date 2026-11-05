import mongoose from 'mongoose';

/**
 * Registro de un pago completado vía Stripe (modo test).
 * Cumple dos funciones:
 *  - Idempotencia: stripeSessionId es único, así una misma sesión de checkout
 *    no se procesa dos veces (evita doble cobro de créditos al recargar).
 *  - Historial de facturación real que se muestra en la página de Facturación.
 */
const paymentSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', index: true },
    type: { type: String, enum: ['plan', 'credits'], required: true },
    description: { type: String, default: '' },
    amountMXN: { type: Number, required: true },
    tokens: { type: Number, default: 0 }, // solo para compras de créditos
    planKey: { type: String, default: '' },
    packKey: { type: String, default: '' },
    // true = renovación cobrada a la tarjeta guardada.
    renewal: { type: Boolean, default: false },
    // Ciclo del plan pagado (solo type 'plan').
    cycle: { type: String, enum: ['', 'mensual', 'anual'], default: '' },
    stripeSessionId: { type: String, required: true, unique: true },
    // refunded = devuelto (garantía de 30 días del plan anual). No cuenta como ingreso.
    status: { type: String, enum: ['completed', 'refunded'], default: 'completed' },
    refundedAt: { type: Date, default: null },
    refundId: { type: String, default: '' },
  },
  { timestamps: true }
);

export const Payment = mongoose.model('Payment', paymentSchema);
