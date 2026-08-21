import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    tokens: { type: Number, default: 0 },
    // Quién generó un mensaje de assistant: el bot o una persona (agente) que
    // tomó el control. Para role 'user' no aplica (es el cliente).
    via: { type: String, enum: ['bot', 'agent'], default: 'bot' },
    // Imágenes que el bot adjuntó en este mensaje (Elite): {label, url}.
    images: {
      type: [{ label: String, url: String }],
      default: undefined,
    },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

/**
 * Historial del simulador de WhatsApp. Cada documento es una "conversación de
 * prueba" que el cliente puede revisar después. Aislado por Business.
 */
const chatSimulationSchema = new mongoose.Schema(
  {
    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    title: { type: String, default: 'Nueva conversación' },
    // Canal de origen: 'simulator' (pruebas del panel) o 'whatsapp' (cliente real
    // vía Meta Cloud API). Sirve para separar pruebas de conversaciones reales.
    channel: { type: String, enum: ['simulator', 'whatsapp'], default: 'simulator' },
    // Datos del cliente real de WhatsApp (vacíos en el simulador).
    customerPhone: { type: String, default: '' }, // wa_id (solo dígitos, ej. 5216181234567)
    customerName: { type: String, default: '' },
    messages: { type: [messageSchema], default: [] },
    // Relevo humano: 'bot' = el bot responde automáticamente; 'manual' = una
    // persona tomó el control y el bot no responde en esta conversación.
    handoffMode: { type: String, enum: ['bot', 'manual'], default: 'bot' },
    // El bot marcó la conversación para que la atienda una persona.
    needsAttention: { type: Boolean, default: false },
    attentionReason: { type: String, default: '' },
  },
  { timestamps: true }
);

// Ubicar rápido la conversación abierta de un cliente de WhatsApp por su teléfono.
chatSimulationSchema.index({ business: 1, channel: 1, customerPhone: 1 });

export const ChatSimulation = mongoose.model('ChatSimulation', chatSimulationSchema);
