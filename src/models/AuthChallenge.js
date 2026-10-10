import mongoose from 'mongoose';

/**
 * Reto de un solo uso para llaves de acceso (WebAuthn). Vive 5 minutos y se
 * borra al usarse, así una respuesta firmada no se puede reutilizar.
 */
const authChallengeSchema = new mongoose.Schema(
  {
    challenge: { type: String, required: true },
    purpose: { type: String, enum: ['register', 'login', 'stepup'], required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

authChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AuthChallenge = mongoose.model('AuthChallenge', authChallengeSchema);
