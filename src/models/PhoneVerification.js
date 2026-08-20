import mongoose from 'mongoose';

/**
 * Verificación OTP del número de WhatsApp de un negocio. Guarda el código
 * HASHEADO (nunca en claro), su expiración y el nº de intentos. Hay a lo más
 * una verificación activa por negocio (se re-emite en cada envío). Un índice TTL
 * borra las expiradas automáticamente.
 */
const phoneVerificationSchema = new mongoose.Schema(
  {
    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      unique: true, // una verificación activa por negocio
    },
    phone: { type: String, required: true }, // objetivo en E.164
    codeHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    lastSentAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Limpieza automática al vencer (Mongo borra el doc cuando expiresAt < ahora).
phoneVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PhoneVerification = mongoose.model('PhoneVerification', phoneVerificationSchema);
