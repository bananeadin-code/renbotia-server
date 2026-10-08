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
    // Respuestas rápidas (canned) que el AGENTE inserta al responder en modo
    // manual desde la bandeja. No las usa el bot; son atajos para la persona.
    quickReplies: { type: [String], default: [] },
    // Avisos temporales ("hoy cerramos a las 4", "ya no hay pastel de chocolate"):
    // información vigente que el bot comunica y que vence sola. Se ponen desde
    // Entrenamiento o desde el WhatsApp del dueño.
    notices: {
      type: [
        {
          text: { type: String, required: true, maxlength: 200 },
          until: { type: Date, default: null }, // null = hasta que se quite
          createdAt: { type: Date, default: Date.now },
          via: { type: String, enum: ['panel', 'whatsapp'], default: 'panel' },
        },
      ],
      default: [],
    },
    // Seguimiento automático (Pro/Elite): si el cliente deja de responder tras la
    // última respuesta del bot, se le escribe UNA vez dentro de la ventana de 24h.
    // mode 'ai' = el bot redacta según la conversación; 'custom' = texto fijo.
    followUp: {
      enabled: { type: Boolean, default: false },
      delayHours: { type: Number, default: 4, min: 1, max: 20 },
      mode: { type: String, enum: ['ai', 'custom'], default: 'ai' },
      message: { type: String, default: '', maxlength: 500 },
      // Seguimiento DESPUÉS de las 24 h (solo WhatsApp): Meta solo permite
      // escribir con una plantilla aprobada. Uno por silencio del cliente.
      template: {
        enabled: { type: Boolean, default: false },
        name: { type: String, default: '', maxlength: 512 },
        language: { type: String, default: 'es_MX', maxlength: 10 },
        // Horas de silencio antes de enviarla (mín. 24: antes de eso basta el
        // seguimiento normal; máx. 7 días).
        delayHours: { type: Number, default: 48, min: 24, max: 168 },
        // Valores de las variables del cuerpo, en orden. {nombre} = cliente.
        params: { type: [String], default: [] },
        nameFallback: { type: String, default: 'cliente', maxlength: 40 },
      },
    },
    // Horario de atención. botMode 'always' = el bot contesta siempre (y si está
    // cerrado lo comunica con closedMessage); 'closed_only' = el bot solo
    // contesta fuera del horario y dentro atiende una persona desde la bandeja.
    schedule: {
      enabled: { type: Boolean, default: false },
      timezone: { type: String, default: 'America/Mexico_City' },
      botMode: { type: String, enum: ['always', 'closed_only'], default: 'always' },
      days: {
        type: [
          {
            _id: false,
            day: { type: Number, min: 0, max: 6 },
            enabled: { type: Boolean, default: true },
            open: { type: String, default: '09:00' },
            close: { type: String, default: '18:00' },
          },
        ],
        default: undefined,
      },
      closedMessage: { type: String, default: '', maxlength: 300 },
    },
    // Elite: documentos de contexto subidos por el negocio (PDF, texto). Guardamos
    // el TEXTO ya extraído (no el archivo) como material de referencia del bot.
    documents: {
      type: [
        {
          name: { type: String, default: '', trim: true },
          text: { type: String, default: '' },
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

export const BotConfig = mongoose.model('BotConfig', botConfigSchema);
