import { asyncHandler } from '../utils/asyncHandler.js';
import { ChatSimulation } from '../models/ChatSimulation.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * Historial de conversaciones del simulador, aislado por Business.
 * En la Fase 2 solo lectura/gestión; el envío de mensajes (que llama a Claude)
 * llega en la Fase 3.
 */
export const listChats = asyncHandler(async (req, res) => {
  const chats = await ChatSimulation.find({ business: req.businessId })
    .select('title createdAt updatedAt messages')
    .sort({ updatedAt: -1 })
    .lean();

  // Resumen ligero para la lista (sin traer todos los mensajes al frente).
  const summary = chats.map((c) => ({
    id: c._id,
    title: c.title,
    messageCount: c.messages.length,
    lastMessageAt: c.messages.at(-1)?.timestamp || c.updatedAt,
    createdAt: c.createdAt,
  }));

  res.json({ success: true, data: { chats: summary } });
});

export const getChat = asyncHandler(async (req, res) => {
  const chat = await ChatSimulation.findOne({
    _id: req.params.id,
    business: req.businessId, // el filtro por tenant impide leer chats ajenos
  });
  if (!chat) {
    throw ApiError.notFound('Conversación no encontrada');
  }
  res.json({ success: true, data: { chat } });
});

export const deleteChat = asyncHandler(async (req, res) => {
  const deleted = await ChatSimulation.findOneAndDelete({
    _id: req.params.id,
    business: req.businessId,
  });
  if (!deleted) {
    throw ApiError.notFound('Conversación no encontrada');
  }
  res.json({ success: true, message: 'Conversación eliminada' });
});
