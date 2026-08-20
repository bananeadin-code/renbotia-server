import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { processMessage } from '../services/simulator.service.js';

export const sendMessageSchema = z.object({
  message: z.string().min(1, 'El mensaje no puede estar vacío').max(2000),
  chatId: z.string().length(24, 'chatId inválido').optional(),
});

/**
 * POST /api/simulator/message
 * Envía un mensaje al bot del negocio y devuelve la respuesta de Claude,
 * el balance actualizado y el id de la conversación.
 */
export const sendMessage = asyncHandler(async (req, res) => {
  const result = await processMessage({
    businessId: req.businessId,
    business: req.business,
    message: req.body.message,
    chatId: req.body.chatId,
  });

  res.json({ success: true, data: result });
});
