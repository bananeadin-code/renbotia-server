import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendContactEmail } from '../services/email.service.js';
import { logger } from '../utils/logger.js';

const TOPICS = ['Conexión de WhatsApp', 'Ventas y planes', 'Facturación', 'Soporte', 'Otro'];

export const contactSchema = z.object({
  name: z.string().trim().min(2, 'Escribe tu nombre').max(80),
  email: z.string().trim().email('Correo inválido').max(120),
  topic: z.string().max(60).optional(),
  message: z.string().trim().min(10, 'Cuéntanos un poco más').max(2000),
  // Honeypot anti-bots: campo oculto que una persona nunca llena. Si viene con
  // contenido, es un bot → respondemos éxito pero NO enviamos nada.
  website: z.string().max(0).optional().or(z.literal('')),
});

/**
 * POST /api/contact — formulario de contacto público. Envía el mensaje a tu
 * buzón vía Resend (saliente; NO depende del reenvío entrante del dominio).
 * Fail-open y anti-spam (honeypot + rate limit en la ruta).
 */
export const submitContact = asyncHandler(async (req, res) => {
  // Honeypot lleno = bot: cortamos en silencio (parece éxito).
  if (req.body.website) {
    return res.json({ success: true, message: 'Gracias, te responderemos pronto.' });
  }

  const topic = TOPICS.includes(req.body.topic) ? req.body.topic : 'Otro';
  const result = await sendContactEmail({
    name: req.body.name.trim(),
    email: req.body.email.trim(),
    topic,
    message: req.body.message.trim(),
  });

  if (result?.skipped) {
    // Sin buzón/clave configurada: no perdemos el mensaje en silencio.
    logger.warn(
      `[contact] Mensaje no entregado (buzón/clave sin configurar) de ${req.body.email}: ${req.body.message.slice(0, 120)}`
    );
  }

  // Siempre respondemos éxito a la persona (la entrega es responsabilidad nuestra).
  res.json({ success: true, message: 'Gracias, recibimos tu mensaje y te responderemos pronto.' });
});
