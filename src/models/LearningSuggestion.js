import mongoose from 'mongoose';

/**
 * "Aprende de ti": cosas que el bot podría aprender, detectadas en la operación
 * diaria. El dueño las revisa en Entrenamiento y con un clic las convierte en
 * pregunta frecuente (o las descarta).
 *
 * source:
 *  - agent: una persona contestó a mano en la bandeja (trae pregunta y respuesta).
 *  - rating: el dueño calificó mal una respuesta del bot (falta la buena respuesta).
 *  - escalation: el bot pidió ayuda humana porque no supo (falta la respuesta).
 */
const learningSuggestionSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    chat: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatSimulation', default: null },
    source: { type: String, enum: ['agent', 'rating', 'escalation'], required: true },
    question: { type: String, required: true, maxlength: 500 },
    // Para deduplicar: misma pregunta normalizada = una sola sugerencia pendiente.
    questionKey: { type: String, required: true },
    answer: { type: String, default: '', maxlength: 2000 },
    status: { type: String, enum: ['pending', 'accepted', 'dismissed'], default: 'pending', index: true },
  },
  { timestamps: true }
);

learningSuggestionSchema.index({ business: 1, status: 1, questionKey: 1 });
// Limpieza: las sugerencias viejas (atendidas o no) se borran solas a los 60 días.
learningSuggestionSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 60 * 24 * 60 * 60 });

export const LearningSuggestion = mongoose.model('LearningSuggestion', learningSuggestionSchema);
