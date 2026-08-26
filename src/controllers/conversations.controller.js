import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ChatSimulation } from '../models/ChatSimulation.js';
import { Business } from '../models/Business.js';
import { logAudit } from '../services/audit.service.js';
import { sendText } from '../services/whatsapp.service.js';
import { toCsv } from '../utils/csv.js';

/**
 * Bandeja de Conversaciones: gestión de la actividad de chat del bot, con modo
 * Bot/Manual (relevo humano) y escalaciones. Opera sobre ChatSimulation; el
 * mismo modelo recibirá conversaciones reales cuando se conecte WhatsApp.
 */

/** GET /api/conversations — lista de conversaciones con resumen. */
export const listConversations = asyncHandler(async (req, res) => {
  const chats = await ChatSimulation.find({ business: req.businessId })
    .sort({ updatedAt: -1 })
    .limit(100)
    .lean();

  const conversations = chats.map((c) => {
    const last = c.messages[c.messages.length - 1];
    return {
      id: c._id,
      title: c.title,
      lastMessage: last ? last.content.slice(0, 90) : '',
      lastRole: last?.role,
      lastAt: c.updatedAt,
      handoffMode: c.handoffMode || 'bot',
      needsAttention: Boolean(c.needsAttention),
      attentionReason: c.attentionReason || '',
      messageCount: c.messages.length,
    };
  });

  res.json({
    success: true,
    data: {
      conversations,
      needAttention: conversations.filter((c) => c.needsAttention).length,
    },
  });
});

/** GET /api/conversations/:id — hilo completo. */
export const getConversation = asyncHandler(async (req, res) => {
  const chat = await ChatSimulation.findOne({ _id: req.params.id, business: req.businessId }).lean();
  if (!chat) throw ApiError.notFound('Conversación no encontrada');
  res.json({ success: true, data: { conversation: chat } });
});

export const updateConversationSchema = z.object({
  handoffMode: z.enum(['bot', 'manual']).optional(),
  needsAttention: z.boolean().optional(),
});

/** PATCH /api/conversations/:id — cambia el modo (bot/manual) o limpia la alerta. */
export const updateConversation = asyncHandler(async (req, res) => {
  const chat = await ChatSimulation.findOne({ _id: req.params.id, business: req.businessId });
  if (!chat) throw ApiError.notFound('Conversación no encontrada');

  const prevMode = chat.handoffMode;
  if (req.body.handoffMode !== undefined) chat.handoffMode = req.body.handoffMode;
  if (req.body.needsAttention !== undefined) chat.needsAttention = req.body.needsAttention;
  await chat.save();

  if (req.body.handoffMode !== undefined && req.body.handoffMode !== prevMode) {
    void logAudit({
      businessId: req.businessId,
      userId: req.userId,
      action: 'conversation.mode',
      summary:
        req.body.handoffMode === 'manual'
          ? 'Tomó el control de una conversación (modo manual).'
          : 'Devolvió una conversación al bot (modo automático).',
      metadata: { conversationId: String(chat._id) },
    });
  }

  res.json({ success: true, data: { conversation: chat } });
});

export const replySchema = z.object({ message: z.string().min(1, 'Escribe un mensaje').max(2000) });

/**
 * POST /api/conversations/:id/reply — responde como PERSONA (agente). Toma el
 * control (modo manual) y limpia la alerta. En el simulador el mensaje solo se
 * agrega al hilo; con WhatsApp real se enviaría al cliente por la Cloud API.
 */
export const replyAsAgent = asyncHandler(async (req, res) => {
  const chat = await ChatSimulation.findOne({ _id: req.params.id, business: req.businessId });
  if (!chat) throw ApiError.notFound('Conversación no encontrada');

  chat.messages.push({
    role: 'assistant',
    content: req.body.message.trim(),
    via: 'agent',
    timestamp: new Date(),
  });
  chat.handoffMode = 'manual'; // responder como humano implica tomar el control
  chat.needsAttention = false;
  await chat.save();

  // Si es una conversación real de WhatsApp, el mensaje del agente sale al cliente
  // por la Cloud API (best-effort; no bloquea la respuesta HTTP).
  if (chat.channel === 'whatsapp' && chat.customerPhone) {
    const biz = await Business.findById(req.businessId).select('whatsappPhoneNumberId');
    void sendText({
      phoneNumberId: biz?.whatsappPhoneNumberId,
      to: chat.customerPhone,
      text: req.body.message.trim(),
    });
  }

  res.json({ success: true, data: { conversation: chat } });
});

/** GET /api/conversations/export — descarga las conversaciones en CSV. */
export const exportConversations = asyncHandler(async (req, res) => {
  const chats = await ChatSimulation.find({ business: req.businessId })
    .sort({ updatedAt: -1 })
    .limit(5000)
    .lean();

  const rows = chats.map((c) => {
    const last = c.messages[c.messages.length - 1];
    return {
      fecha: new Date(c.updatedAt).toLocaleString('es-MX'),
      canal: c.channel || 'simulator',
      cliente: c.customerName || c.title || '',
      telefono: c.customerPhone || '',
      mensajes: c.messages.length,
      modo: c.handoffMode || 'bot',
      atencion: c.needsAttention ? 'sí' : 'no',
      ultimo: last ? last.content : '',
    };
  });

  const csv = toCsv(rows, [
    { label: 'Fecha', get: (r) => r.fecha },
    { label: 'Canal', get: (r) => r.canal },
    { label: 'Cliente', get: (r) => r.cliente },
    { label: 'Teléfono', get: (r) => r.telefono },
    { label: 'Mensajes', get: (r) => r.mensajes },
    { label: 'Modo', get: (r) => r.modo },
    { label: 'Requiere atención', get: (r) => r.atencion },
    { label: 'Último mensaje', get: (r) => r.ultimo },
  ]);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="conversaciones-renbotia.csv"');
  res.send(csv);
});

export const rateSchema = z.object({
  index: z.number().int().min(0),
  rating: z.enum(['up', 'down']).nullable(),
});

/** POST /api/conversations/:id/rate — califica una respuesta del bot (up/down). */
export const rateMessage = asyncHandler(async (req, res) => {
  const chat = await ChatSimulation.findOne({ _id: req.params.id, business: req.businessId });
  if (!chat) throw ApiError.notFound('Conversación no encontrada');

  const msg = chat.messages[req.body.index];
  if (!msg || msg.role !== 'assistant') {
    throw ApiError.badRequest('Solo se pueden calificar respuestas del asistente.');
  }
  msg.rating = req.body.rating; // 'up' | 'down' | null (para quitar la calificación)
  await chat.save();
  res.json({ success: true, data: { conversation: chat } });
});
