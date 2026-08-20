import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { buildSystemPrompt } from '../services/promptBuilder.service.js';
import { generateReply } from '../services/claude.service.js';
import { logger } from '../utils/logger.js';

/**
 * Demo PÚBLICA (sin registro): deja que un visitante pruebe el bot antes de crear
 * cuenta. Es stateless (el cliente reenvía el historial corto) y usa un bot de
 * EJEMPLO fijo. Está rate-limited (demoLimiter) porque llama a Claude, que cuesta.
 * Reusa buildSystemPrompt → hereda el mismo blindaje anti-inyección del producto.
 */

// Negocio y bot de ejemplo (un despacho, para el público objetivo). El visitante
// entiende que es una demostración; en su cuenta entrenaría el suyo con sus datos.
const DEMO_BUSINESS = { name: 'Despacho Ejemplo', industry: 'legal', industryOther: '' };

const DEMO_BOTCONFIG = {
  botName: 'Asistente de RenBotIA',
  tone: 'cercano',
  systemPrompt: '',
  extraContext: '',
  businessInfo: {
    hours: 'Lunes a viernes de 9:00 a 18:00',
    location: 'Centro, Durango',
    services: ['Derecho civil', 'Mercantil', 'Laboral', 'Amparo'],
    basePricing: 'Consulta inicial desde $500 MXN (deducible si contratas).',
  },
  faqs: [
    {
      question: '¿Cuánto cuesta una consulta?',
      answer:
        'La consulta inicial cuesta $500 MXN y es deducible si decides contratar nuestros servicios.',
    },
    {
      question: '¿Qué áreas manejan?',
      answer: 'Derecho civil, mercantil, laboral y amparo. Cuéntanos tu caso y te orientamos.',
    },
    {
      question: '¿Cómo agendo una cita?',
      answer:
        'Con gusto. Dime qué día te acomoda y el área de tu caso, y te propongo un horario disponible.',
    },
    {
      question: '¿Dónde están ubicados?',
      answer: 'En el Centro de Durango. También atendemos consultas iniciales por WhatsApp.',
    },
  ],
  images: [],
};

export const demoMessageSchema = z.object({
  message: z.string().min(1, 'Escribe un mensaje').max(500),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(2000),
      })
    )
    .max(12)
    .optional()
    .default([]),
});

/**
 * POST /api/demo/message  (público, sin auth)
 * Responde como el bot de ejemplo. No descuenta tokens (es costo de marketing);
 * el gasto se acota con demoLimiter + max_tokens + ventana de historial.
 */
export const demoMessage = asyncHandler(async (req, res) => {
  const { message, history } = req.body;
  const system = buildSystemPrompt(DEMO_BOTCONFIG, DEMO_BUSINESS);
  const messages = [...history.slice(-8), { role: 'user', content: message }];

  try {
    const { text } = await generateReply({ system, messages });
    res.json({ success: true, data: { reply: text } });
  } catch (err) {
    // Degradación con gracia también aquí: nunca romper la demo con un error feo.
    logger.warn(`Demo: IA no disponible (${err.statusCode || 'sin status'}). ${err.message}`);
    res.json({
      success: true,
      data: {
        reply: 'En este momento no puedo responder. Intenta de nuevo en unos minutos.',
        degraded: true,
      },
    });
  }
});
