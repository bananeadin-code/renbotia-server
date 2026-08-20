import mongoose from 'mongoose';

const faqSchema = new mongoose.Schema(
  {
    question: { type: String, required: true, trim: true },
    answer: { type: String, required: true, trim: true },
  },
  { _id: true }
);

/**
 * Configuración del bot de un Business (1:1). Es lo que edita el cliente en el
 * panel de entrenamiento y lo que alimenta el system prompt en el simulador.
 */
const botConfigSchema = new mongoose.Schema(
  {
    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      unique: true,
      index: true,
    },
    botName: { type: String, trim: true, default: 'Asistente' },
    tone: {
      type: String,
      enum: ['formal', 'cercano', 'neutral', 'tecnico'],
      default: 'cercano',
    },
    // Personalidad/instrucciones base editable por el cliente.
    systemPrompt: {
      type: String,
      default: '',
      maxlength: 4000,
    },
    faqs: { type: [faqSchema], default: [] },
    businessInfo: {
      hours: { type: String, default: '' },
      location: { type: String, default: '' },
      services: { type: [String], default: [] },
      basePricing: { type: String, default: '' },
    },
    // Pro/Elite: prompt libre para adaptar el bot a fondo (contexto ampliado).
    extraContext: { type: String, default: '', maxlength: 6000 },
    // Elite: imágenes que el bot puede ofrecer/enviar cuando el cliente lo pida.
    images: {
      type: [
        {
          label: { type: String, default: '', trim: true },
          url: { type: String, default: '', trim: true },
          context: { type: String, default: '', trim: true }, // cuándo usarla
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

export const BotConfig = mongoose.model('BotConfig', botConfigSchema);
