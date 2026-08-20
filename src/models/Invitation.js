import mongoose from 'mongoose';

/**
 * Invitación a colaborar en un negocio. Se crea por email; si la persona aún no
 * tiene cuenta, se registra y luego acepta con el token. Un índice TTL borra las
 * vencidas automáticamente.
 */
const invitationSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    role: { type: String, enum: ['colaborador'], default: 'colaborador' },
    token: { type: String, required: true, unique: true },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// A lo más una invitación pendiente por email y negocio.
invitationSchema.index({ business: 1, email: 1 }, { unique: true });
invitationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Invitation = mongoose.model('Invitation', invitationSchema);
