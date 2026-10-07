import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ChatSimulation } from '../models/ChatSimulation.js';
import { UsageLog } from '../models/UsageLog.js';
import '../models/User.js'; // populate de startedBy
import { Business } from '../models/Business.js';
import { logAudit } from '../services/audit.service.js';
import { sendText, sendTemplate, listTemplates } from '../services/whatsapp.service.js';
import { sendMessengerText } from '../services/messenger.service.js';
import { sendInstagramText } from '../services/instagram.service.js';
import { summarizeConversation } from '../services/conversationSummary.service.js';
import { computeServiceWindow } from '../utils/whatsappWindow.js';
import { toCsv } from '../utils/csv.js';
import { recordSuggestion, lastCustomerMessage, dropPending } from '../services/learning.service.js';
import { CONVERSATION_RETENTION_DAYS } from '../config/constants.js';

/**
 * Bandeja de Conversaciones: gestión de la actividad de chat del bot, con modo
 * Bot/Manual (relevo humano) y escalaciones. Opera sobre ChatSimulation; el
 * mismo modelo recibirá conversaciones reales cuando se conecte WhatsApp.
 */

/**
 * GET /api/conversations?scope=real|simulator — lista con resumen.
 * real (por defecto): clientes de los canales conectados. simulator: las pruebas
 * del equipo en el Simulador, aparte, con quién las hizo y cuántos tokens gastó
 * (sin modo manual ni etiquetas: no son clientes).
 */
export const listConversations = asyncHandler(async (req, res) => {
  const simulator = req.query.scope === 'simulator';
  const filter = { business: req.businessId, channel: simulator ? 'simulator' : { $ne: 'simulator' } };
  const [chats, simulatorCount] = await Promise.all([
    ChatSimulation.find(filter)
      .sort({ updatedAt: -1 })
      .limit(100)
      .populate(simulator ? { path: 'startedBy', select: 'name email' } : [])
      .lean(),
    ChatSimulation.countDocuments({ business: req.businessId, channel: 'simulator' }),
  ]);

  // Tokens por prueba del simulador (de UsageLog; si es una prueba anterior al
  // registro por conversación, se suman los tokens guardados en sus mensajes).
  let tokensByChat = {};
  if (simulator && chats.length) {
    const agg = await UsageLog.aggregate([
      { $match: { business: req.businessId, chat: { $in: chats.map((c) => c._id) } } },
      { $group: { _id: '$chat', tokens: { $sum: '$totalTokens' } } },
    ]);
    tokensByChat = Object.fromEntries(agg.map((a) => [String(a._id), a.tokens]));
  }

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
      channel: c.channel || 'simulator',
      customerName: c.customerName || '',
      customerContact: c.customerContact || '',
      tags: c.tags || [],
      // Tipo de registro de trabajo captado (cita/pedido/prospecto…) o '' si ninguno.
      capturedRecordType: c.capturedRecordType || '',
      // Lead caliente: el bot detectó alta intención de compra (oportunidad).
      hotLead: Boolean(c.hotLead),
      hotLeadReason: c.hotLeadReason || '',
      // Ventana de 24h (WhatsApp, Messenger e Instagram; null en simulador y web).
      whatsappWindow: computeServiceWindow(c),
      ...(simulator
        ? {
            startedBy: c.startedBy ? { name: c.startedBy.name || c.startedBy.email, email: c.startedBy.email } : null,
            tokens:
              tokensByChat[String(c._id)] ?? (c.messages || []).reduce((n, m) => n + (m.tokens || 0), 0),
          }
        : {}),
    };
  });

  res.json({
    success: true,
    data: {
      conversations,
      needAttention: conversations.filter((c) => c.needsAttention).length,
      hotLeads: conversations.filter((c) => c.hotLead).length,
      scope: simulator ? 'simulator' : 'real',
      simulatorCount,
      // Días sin actividad tras los que una conversación se elimina sola.
      retentionDays: CONVERSATION_RETENTION_DAYS,
    },
  });
});

/** GET /api/conversations/:id — hilo completo + estado de la ventana de 24h. */
export const getConversation = asyncHandler(async (req, res) => {
  const chat = await ChatSimulation.findOne({ _id: req.params.id, business: req.businessId }).lean();
  if (!chat) throw ApiError.notFound('Conversación no encontrada');
  res.json({
    success: true,
    data: { conversation: chat, whatsappWindow: computeServiceWindow(chat) },
  });
});

export const updateConversationSchema = z.object({
  handoffMode: z.enum(['bot', 'manual']).optional(),
  needsAttention: z.boolean().optional(),
  title: z.string().max(80).optional(), // renombrar la conversación
  tags: z.array(z.string().max(24)).max(8).optional(), // etiquetas del agente
  hotLead: z.boolean().optional(), // marcar/atender el lead caliente (el agente lo cierra)
});

/** PATCH /api/conversations/:id — cambia el modo (bot/manual) o limpia la alerta. */
export const updateConversation = asyncHandler(async (req, res) => {
  const chat = await ChatSimulation.findOne({ _id: req.params.id, business: req.businessId });
  if (!chat) throw ApiError.notFound('Conversación no encontrada');
  if (
    chat.channel === 'simulator' &&
    (req.body.handoffMode !== undefined || req.body.tags !== undefined || req.body.hotLead !== undefined)
  ) {
    throw new ApiError(400, 'Las pruebas del simulador no tienen modo manual, etiquetas ni leads.', {
      code: 'SIMULATOR_READONLY',
    });
  }

  const prevMode = chat.handoffMode;
  if (req.body.handoffMode !== undefined) chat.handoffMode = req.body.handoffMode;
  if (req.body.needsAttention !== undefined) chat.needsAttention = req.body.needsAttention;
  if (req.body.title !== undefined) {
    const t = req.body.title.trim();
    if (t) chat.title = t;
  }
  if (req.body.tags !== undefined) {
    // Normaliza: recorta, minúsculas, sin vacíos ni duplicados.
    chat.tags = [...new Set(req.body.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 8);
  }
  if (req.body.hotLead !== undefined) {
    // El agente cierra/reabre el lead caliente manualmente (p. ej. tras darle
    // seguimiento). Al cerrarlo se limpia el motivo; al marcarlo se fija la fecha.
    chat.hotLead = req.body.hotLead;
    if (!req.body.hotLead) chat.hotLeadReason = '';
    else if (!chat.hotLeadAt) chat.hotLeadAt = new Date();
  }
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
  if (chat.channel === 'simulator') {
    throw new ApiError(400, 'Las pruebas del simulador no se responden como persona. Usa el Simulador.', {
      code: 'SIMULATOR_READONLY',
    });
  }

  const text = req.body.message.trim();

  // Fuera de la ventana de 24h Meta rechaza el texto libre. Se bloquea aquí para
  // orientar al agente: en WhatsApp con una plantilla; en Messenger, esperar a
  // que el cliente vuelva a escribir.
  const win = computeServiceWindow(chat);
  if (win && !win.open) {
    throw new ApiError(
      409,
      chat.channel === 'facebook' || chat.channel === 'instagram'
        ? `Pasaron más de 24 horas desde el último mensaje del cliente. ${chat.channel === 'instagram' ? 'Instagram' : 'Messenger'} no permite responder hasta que vuelva a escribir.`
        : 'La ventana de 24 horas está cerrada. Para reactivar esta conversación, envía una plantilla aprobada.',
      { code: 'WINDOW_CLOSED' }
    );
  }

  // Aprende de ti: lo que el cliente preguntó y la persona contestó.
  const customerQuestion = lastCustomerMessage(chat);
  chat.messages.push({ role: 'assistant', content: text, via: 'agent', timestamp: new Date() });
  chat.handoffMode = 'manual'; // responder como humano implica tomar el control
  chat.needsAttention = false;
  await chat.save();

  // Conversación real de WhatsApp: el mensaje del agente sale al cliente por la
  // Cloud API. Esperamos el resultado para poder ORIENTAR si algo falla.
  let sendWarning = null;
  if (chat.channel === 'whatsapp' && chat.customerPhone) {
    const biz = await Business.findById(req.businessId).select('whatsappPhoneNumberId');
    const result = await sendText({ phoneNumberId: biz?.whatsappPhoneNumberId, to: chat.customerPhone, text });
    if (!result.ok) {
      sendWarning = result.billing
        ? 'El mensaje se guardó, pero Meta no lo entregó: falta un método de pago en tu cuenta de Meta.'
        : 'El mensaje se guardó, pero no se pudo entregar por WhatsApp. Intenta de nuevo en un momento.';
    }
  }

  // Conversación de Messenger: sale al cliente con el token de la Página.
  if (chat.channel === 'facebook' && chat.customerId) {
    const biz = await Business.findById(req.businessId).select('+facebookPageToken');
    const result = await sendMessengerText({
      pageToken: biz?.facebookPageToken,
      recipientId: chat.customerId,
      text,
    });
    if (!result.ok) {
      sendWarning = 'El mensaje se guardó, pero no se pudo entregar por Messenger. Intenta de nuevo en un momento.';
    }
  }

  // Conversación de Instagram: sale por la Página ligada a la cuenta de IG.
  if (chat.channel === 'instagram' && chat.customerId) {
    const biz = await Business.findById(req.businessId).select('+instagramPageToken');
    const result = await sendInstagramText({
      pageToken: biz?.instagramPageToken,
      recipientId: chat.customerId,
      text,
    });
    if (!result.ok) {
      sendWarning = 'El mensaje se guardó, pero no se pudo entregar por Instagram. Intenta de nuevo en un momento.';
    }
  }

  // Se propone al dueño que el bot aprenda esta respuesta (en la bandeja y en
  // Entrenamiento). Solo si hubo una pregunta del cliente a la que responde.
  const suggestion = customerQuestion
    ? await recordSuggestion({
        businessId: req.businessId,
        chatId: chat._id,
        source: 'agent',
        question: customerQuestion,
        answer: text,
      })
    : null;

  res.json({
    success: true,
    data: {
      conversation: chat,
      sendWarning,
      suggestion: suggestion ? { id: suggestion._id, question: suggestion.question, answer: suggestion.answer } : null,
    },
  });
});

export const templateSchema = z.object({
  templateName: z.string().min(1, 'Elige una plantilla').max(512),
  languageCode: z.string().min(2).max(10).optional(),
});

/**
 * POST /api/conversations/:id/template — envía una PLANTILLA aprobada. Es la vía
 * para reactivar una conversación de WhatsApp cuya ventana de 24h ya cerró.
 */
export const sendTemplateReply = asyncHandler(async (req, res) => {
  const chat = await ChatSimulation.findOne({ _id: req.params.id, business: req.businessId });
  if (!chat) throw ApiError.notFound('Conversación no encontrada');
  if (chat.channel !== 'whatsapp' || !chat.customerPhone) {
    throw ApiError.badRequest('Las plantillas solo se envían en conversaciones de WhatsApp.');
  }

  const biz = await Business.findById(req.businessId).select('whatsappPhoneNumberId');
  const result = await sendTemplate({
    phoneNumberId: biz?.whatsappPhoneNumberId,
    to: chat.customerPhone,
    templateName: req.body.templateName,
    languageCode: req.body.languageCode || 'es_MX',
  });

  if (!result.ok) {
    if (result.billing) {
      throw new ApiError(
        402,
        'Meta no entregó la plantilla: falta un método de pago en tu cuenta de Meta. Agrégalo para poder reactivar conversaciones.',
        { code: 'META_PAYMENT_REQUIRED' }
      );
    }
    throw new ApiError(502, `No se pudo enviar la plantilla: ${result.error}`, { code: 'TEMPLATE_FAILED' });
  }

  // Registrar en el hilo para que el agente vea que se envió.
  chat.messages.push({
    role: 'assistant',
    content: `Plantilla enviada: ${req.body.templateName}`,
    via: 'agent',
    timestamp: new Date(),
  });
  chat.handoffMode = 'manual';
  chat.needsAttention = false;
  await chat.save();

  res.json({ success: true, data: { conversation: chat } });
});

/**
 * GET /api/conversations/templates — plantillas APROBADAS de la WABA del negocio,
 * para ofrecerlas cuando la ventana de 24h está cerrada. `reason` explica por qué
 * viene vacía (sin WABA conectada o falló la consulta) para orientar en la UI.
 */
export const listBusinessTemplates = asyncHandler(async (req, res) => {
  const biz = await Business.findById(req.businessId).select('whatsappWabaId');
  if (!biz?.whatsappWabaId) {
    return res.json({ success: true, data: { templates: [], reason: 'no_waba' } });
  }
  const result = await listTemplates(biz.whatsappWabaId);
  const approved = (result.templates || []).filter((t) => t.status === 'APPROVED');
  res.json({
    success: true,
    data: { templates: approved, reason: result.ok ? null : 'fetch_failed' },
  });
});

/** POST /api/conversations/:id/summary — resumen con IA + respuesta sugerida. */
export const summarizeConv = asyncHandler(async (req, res) => {
  const data = await summarizeConversation({ businessId: req.businessId, chatId: req.params.id });
  res.json({ success: true, data });
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
      contacto: c.customerContact || '',
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
    { label: 'Contacto (sitio web)', get: (r) => r.contacto },
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
  const prev = msg.rating;
  msg.rating = req.body.rating; // 'up' | 'down' | null (para quitar la calificación)
  await chat.save();

  // Aprende de ti: una respuesta mal calificada queda como pendiente por enseñar
  // (con la pregunta del cliente); si se quita el "mal", se retira.
  const question = lastCustomerMessage(chat, req.body.index);
  if (question && req.body.rating === 'down' && prev !== 'down') {
    await recordSuggestion({ businessId: req.businessId, chatId: chat._id, source: 'rating', question });
  } else if (question && prev === 'down' && req.body.rating !== 'down') {
    await dropPending({ businessId: req.businessId, question, source: 'rating' });
  }
  res.json({ success: true, data: { conversation: chat } });
});
