import mongoose from 'mongoose';

/**
 * Código de un solo uso (OTP) enviado por email. Sirve para:
 *  - 'verify_email': confirmar el correo al registrarse.
 *  - 'login_2fa':    segundo factor al iniciar sesión.
 * El código se guarda HASHEADO (nunca en claro). Un índice TTL borra los vencidos.
 */
const emailOtpSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    purpose: { type: String, enum: ['verify_email', 'login_2fa'], required: true },
    codeHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    lastSentAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Un solo OTP activo por usuario y propósito (se reemplaza al reenviar).
emailOtpSchema.index({ user: 1, purpose: 1 }, { unique: true });
emailOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const EmailOtp = mongoose.model('EmailOtp', emailOtpSchema);
