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
    stripeSessionId: { type: String, required: true, unique: true },
    status: { type: String, enum: ['completed'], default: 'completed' },
  },
  { timestamps: true }
);

export const Payment = mongoose.model('Payment', paymentSchema);
