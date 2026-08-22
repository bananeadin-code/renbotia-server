import mongoose from 'mongoose';

/**
 * Lista de espera de los planes de pago (Pro/Elite) mientras no se pueden comprar
 * (Stripe aún en prueba). Guarda el correo de quien pidió "avísame" para
 * contactarlo cuando se active el plan. Dedupe por (email, planKey).
 */
const waitlistSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    planKey: { type: String, enum: ['pro', 'elite'], required: true },
  },
  { timestamps: true }
);

waitlistSchema.index({ email: 1, planKey: 1 }, { unique: true });

export const Waitlist = mongoose.model('Waitlist', waitlistSchema);
