import { z } from 'zod';
import { inboundFileSchema, parseUploadedFile } from '../utils/inboundFile.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { processMessage } from '../services/simulator.service.js';

export const sendMessageSchema = z
  .object({
    message: z.string().trim().max(2000).optional().default(''),
    chatId: z.string().length(24, 'chatId inválido').optional(),
    // Foto o PDF para probar cómo responde el bot (en Elite los lee; en Free y
    // Pro el bot avisa que no puede verlos, igual que con un cliente real).
    file: inboundFileSchema.optional(),
  })
  .refine((d) => d.message.length > 0 || d.file, { message: 'El mensaje no puede estar vacío', path: ['message'] });

/**
 * POST /api/simulator/message
 * Envía un mensaje al bot del negocio y devuelve la respuesta de Claude,
 * el balance actualizado y el id de la conversación.
 */
export const sendMessage = asyncHandler(async (req, res) => {
  const { image, document } = parseUploadedFile(req.body.file);
  const result = await processMessage({
    businessId: req.businessId,
    business: req.business,
    message: req.body.message,
    image,
    document,
    chatId: req.body.chatId,
    userId: req.userId, // para saber quién del equipo usa el simulador
  });

  res.json({ success: true, data: result });
});
