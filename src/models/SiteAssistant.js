import mongoose from 'mongoose';

/**
 * Asistente IA del SITIO (singleton). Es el bot de soporte/guía que aparece en el
 * widget flotante de las páginas públicas: responde dudas sobre RenBotIA y orienta
 * a los visitantes a elegir un plan. Lo configura el admin (operador) desde el
 * panel, y es a la vez una prueba viva de que la plataforma funciona.
 *
 * Distinto del demo de la landing (bot de ejemplo de un negocio, fijo).
 */
const siteAssistantSchema = new mongoose.Schema(
  {
    // Garantiza un solo documento.
    singleton: { type: String, default: 'site', unique: true },
    botName: { type: String, default: 'Asistente RenBotIA', trim: true, maxlength: 60 },
    tone: {
      type: String,
      enum: ['formal', 'cercano', 'neutral', 'tecnico'],
      default: 'cercano',
    },
    welcomeMessage: {
      type: String,
      default:
        '¡Hola! Soy el asistente de RenBotIA. Te ayudo a resolver dudas sobre la plataforma y a elegir el plan ideal para tu negocio. ¿En qué te ayudo?',
      maxlength: 500,
    },
    quickReplies: {
      type: [String],
      default: ['¿Qué es RenBotIA?', '¿Cuánto cuesta?', '¿Cómo funciona?'],
    },
    businessInfo: {
      hours: { type: String, default: 'Siempre disponible (asistente automático)' },
      location: { type: String, default: 'México · Durango' },
      services: {
        type: [String],
        default: [
          'Bots de WhatsApp con IA entrenados con tu información',
          'Atención automatizada y respuesta a preguntas frecuentes 24/7',
          'Agenda de citas y registro de prospectos (plan Elite)',
        ],
      },
      basePricing: {
        type: String,
        default:
          'Free $0 (50,000 tokens, sin tarjeta) · Pro $429 MXN/mes (1,000,000 tokens) · Elite $999 MXN/mes (5,000,000 tokens + gestión de citas). También hay paquetes de créditos extra.',
      },
    },
    faqs: {
      type: [{ question: String, answer: String }],
      default: [
        {
          question: '¿Qué es RenBotIA?',
          answer:
            'RenBotIA crea asistentes de WhatsApp con inteligencia artificial para tu negocio: responden dudas, agendan citas y captan clientes 24/7, entrenados con tu propia información.',
        },
        {
          question: '¿Cuánto cuesta?',
          answer:
            'Hay un plan Free gratis con 50,000 tokens para probar sin tarjeta. Pro cuesta $429 MXN/mes (1 millón de tokens) y Elite $999 MXN/mes (5 millones + gestión de citas). También puedes comprar paquetes de créditos extra.',
        },
        {
          question: '¿Necesito saber programar?',
          answer:
            'No. Configuras tu bot en un asistente de 3 pasos y lo pruebas en un simulador, todo desde el panel y sin código.',
        },
        {
          question: '¿Se conecta a WhatsApp real?',
          answer:
            'La conexión con WhatsApp Business (Cloud API) está en marcha. Mientras tanto, puedes entrenar y probar tu bot en el simulador incluido.',
        },
      ],
    },
    // Guía adicional para el system prompt (p. ej. cómo orientar a los planes).
    extraContext: {
      type: String,
      default:
        'Eres el asistente del sitio de RenBotIA. Ayudas a los visitantes a entender el producto y a elegir el plan ideal según su negocio: Free para probar, Pro para negocios con actividad constante, y Elite si necesitan agendar citas, enviar imágenes o más volumen. Sé cálido, breve y útil. Cuando tenga sentido, invita a crear una cuenta gratis o a ver los planes. No inventes funciones que no existen ni des precios distintos a los indicados.',
      maxlength: 2000,
    },
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true }
);

/** Devuelve el (único) documento de configuración, creándolo con defaults si no existe. */
siteAssistantSchema.statics.getSingleton = async function getSingleton() {
  let doc = await this.findOne();
  if (doc) return doc;
  try {
    doc = await this.create({});
  } catch (err) {
    // Carrera en el primer acceso (dos requests creando a la vez): recuperamos el existente.
    if (err.code === 11000) doc = await this.findOne();
    else throw err;
  }
  return doc;
};

export const SiteAssistant = mongoose.model('SiteAssistant', siteAssistantSchema);
