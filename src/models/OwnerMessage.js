import mongoose from 'mongoose';

/**
 * Historial corto de la charla del DUEÑO con su asistente por WhatsApp. Sirve
 * para que el asistente entienda respuestas como "en todos" o "sí, hazlo" en
 * el contexto de lo que se venía hablando. Se borra solo a los 3 días.
 */
const ownerMessageSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    waId: { type: String, required: true },
    role: { type: String, enum: ['user', 'assistant'], required: true },
    text: { type: String, required: true, maxlength: 4000 },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

ownerMessageSchema.index({ business: 1, waId: 1, createdAt: -1 });
ownerMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3 * 24 * 60 * 60 });

export const OwnerMessage = mongoose.model('OwnerMessage', ownerMessageSchema);
