import { z } from 'zod';
import { can, canChannel } from '../config/access.js';
import { isBlocked, contactIdOf } from '../utils/blocklist.js';
import { bodyParameters, renderTemplate, fillPlaceholders } from '../utils/waTemplate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import mongoose from 'mongoose';
import { ChatSimulation } from '../models/ChatSimulation.js';
import { ChatAttachment } from '../models/ChatAttachment.js';
import { UsageLog } from '../models/UsageLog.js';
import { User } from '../models/User.js'; // quién hizo cada prueba del simulador
import { Business } from '../models/Business.js';
import { logAudit } from '../services/audit.service.js';
import { sendText, sendTemplate, listTemplates } from '../services/whatsapp.service.js';
import { sendMessengerText } from '../services/messenger.service.js';
import { sendInstagramText } from '../services/instagram.service.js';
import { summarizeConversation } from '../services/conversationSummary.service.js';
import { maybeEmailWebVisitor } from '../services/webVisitor.service.js';
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

/* ── IAM: qué conversaciones ve cada quien ─────────────────────────────────
   - Las pruebas del simulador: quien tiene acceso al simulador.
   - Las de clientes: 'conversations' (ver o editar) y SOLO sus canales
     (p. ej. un agente de Instagram no ve WhatsApp). Fuera de su alcance, la
     conversación "no existe" (404) para no revelar nada. */
function realChannelFilter(req) {
  const ch = req.access?.channels;
  return ch === 'all' || !ch ? { $ne: 'simulator' } : { $in: ch.filter((c) => c !== 'simulator') };
}

function assertChatAccess(req, chat) {
  const ok =
    chat.channel === 'simulator'
      ? can(req.access, 'simulator', 'edit')
      : can(req.access, 'conversations', 'view') && canChannel(req.access, chat.channel);
  if (!ok) throw ApiError.notFound('Conversación no encontrada');
}

export const listConversations = asyncHandler(async (req, res) => {
  const simulator = req.query.scope === 'simulator';
  const canSim = can(req.access, 'simulator', 'edit');
  if (simulator && !canSim) {
    throw new ApiError(403, 'Tu rol no incluye el simulador.', { code: 'ACCESS_DENIED', module: 'simulator' });
  }
  if (!simulator && !can(req.access, 'conversations', 'view')) {
    throw new ApiError(403, 'Tu rol no incluye las conversaciones.', { code: 'ACCESS_DENIED', module: 'conversations' });
  }
  const filter = { business: new mongoose.Types.ObjectId(String(req.businessId)), channel: simulator ? 'simulator' : realChannelFilter(req) };
  // La bandeja solo necesita un RESUMEN de cada conversación: se calcula en la
  // base (último mensaje, cuántos hay, último mensaje del cliente) en vez de traer
  // todos los mensajes con sus imágenes a Node (pesado con conversaciones largas).
  const [chats, simulatorCount] = await Promise.all([
    ChatSimulation.aggregate([
      { $match: filter },
      { $sort: { updatedAt: -1 } },
      { $limit: 100 },
      {
        $project: {
          title: 1,
          updatedAt: 1,
          handoffMode: 1,
          needsAttention: 1,
          attentionReason: 1,
          channel: 1,
          customerName: 1,
          customerContact: 1,
          tags: 1,
          capturedRecordType: 1,
          hotLead: 1,
          hotLeadReason: 1,
          startedBy: 1,
          messageCount: { $size: { $ifNull: ['$messages', []] } },
          last: {
            $let: {
              vars: { m: { $arrayElemAt: [{ $ifNull: ['$messages', []] }, -1] } },
              in: { role: '$$m.role', content: { $substrCP: [{ $ifNull: ['$$m.content', ''] }, 0, 90] } },
            },
          },
          lastInboundAt: {
            $max: {
              $map: {
                input: { $filter: { input: { $ifNull: ['$messages', []] }, as: 'm', cond: { $eq: ['$$m.role', 'user'] } } },
                as: 'm',
                in: '$$m.timestamp',
              },
            },
          },
          ...(simulator ? { msgTokens: { $sum: '$messages.tokens' } } : {}),
        },
      },
    ]),
    canSim ? ChatSimulation.countDocuments({ business: req.businessId, channel: 'simulator' }) : 0,
  ]);
  // Quién hizo cada prueba del simulador (una sola consulta).
  if (simulator && chats.length) {
    const ids = [...new Set(chats.map((c) => String(c.startedBy || '')).filter(Boolean))];
    const users = ids.length ? await User.find({ _id: { $in: ids } }).select('name email').lean() : [];
    const byId = new Map(users.map((u) => [String(u._id), u]));
    for (const c of chats) c.startedBy = c.startedBy ? byId.get(String(c.startedBy)) || null : null;
  }

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
    const last = c.last?.role ? c.last : null;
    return {
      id: c._id,
      title: c.title,
      lastMessage: last ? last.content : '',
      lastRole: last?.role,
      lastAt: c.updatedAt,
      handoffMode: c.handoffMode || 'bot',
      needsAttention: Boolean(c.needsAttention),
      attentionReason: c.attentionReason || '',
      messageCount: c.messageCount,
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
      whatsappWindow: computeServiceWindow({
        channel: c.channel,
        messages: c.lastInboundAt ? [{ role: 'user', timestamp: c.lastInboundAt }] : [],
      }),
      ...(simulator
        ? {
            startedBy: c.startedBy ? { name: c.startedBy.name || c.startedBy.email, email: c.startedBy.email } : null,
            tokens:
              tokensByChat[String(c._id)] ?? (c.msgTokens || 0),
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
  assertChatAccess(req, chat);
  const biz = await Business.findById(req.businessId).select('blockedContacts').lean();
  res.json({
    success: true,
    data: {
      conversation: chat,
      whatsappWindow: computeServiceWindow(chat),
      blocked: chat.channel !== 'simulator' && isBlocked(biz, chat.channel, contactIdOf(chat)),
    },
  });
});

export const blockSchema = z.object({ blocked: z.boolean() });

/**
 * POST /api/conversations/:id/block — bloquea o desbloquea al cliente de esta
 * conversación. Bloqueado, el bot ignora sus mensajes (no se guardan ni gastan
 * créditos) en ese canal.
 */
export const blockContact = asyncHandler(async (req, res) => {
  const chat = await ChatSimulation.findOne({ _id: req.params.id, business: req.businessId })
    .select('channel customerPhone customerId customerName')
    .lean();
  if (!chat) throw ApiError.notFound('Conversación no encontrada');
  assertChatAccess(req, chat);
  if (chat.channel === 'simulator') throw ApiError.badRequest('Las pruebas del simulador no se bloquean.');
  const id = contactIdOf(chat);
  if (!id) throw ApiError.badRequest('No se pudo identificar al contacto.');

  if (req.body.blocked) {
    const biz = await Business.findById(req.businessId).select('blockedContacts');
    if ((biz.blockedContacts || []).length >= 500) {
      throw ApiError.badRequest('Llegaste al máximo de 500 contactos bloqueados. Desbloquea alguno primero.');
    }
    await Business.updateOne(
      { _id: req.businessId, blockedContacts: { $not: { $elemMatch: { channel: chat.channel, id } } } },
      { $push: { blockedContacts: { channel: chat.channel, id, name: chat.customerName || '', by: req.userId } } }
    );
  } else {
    await Business.updateOne({ _id: req.businessId }, { $pull: { blockedContacts: { channel: chat.channel, id } } });
  }
  // Al bloquear deja de "pedir atención" (no es alguien a quien haya que contestar).
  if (req.body.blocked) await ChatSimulation.updateOne({ _id: chat._id }, { $set: { needsAttention: false } });
  void logAudit({
    businessId: req.businessId,
    userId: req.userId,
    action: req.body.blocked ? 'contact.block' : 'contact.unblock',
    summary: `${req.body.blocked ? 'Bloqueó' : 'Desbloqueó'} al contacto ${chat.customerName || id} (${chat.channel}).`,
  });
  res.json({ success: true, data: { blocked: req.body.blocked } });
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
  assertChatAccess(req, chat);
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
  assertChatAccess(req, chat);
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

  // Chat del sitio web: si el visitante ya cerró la página, se le avisa por
  // correo (si dejó uno). Si sigue ahí, la ve en el chat por el sondeo.
  let emailed = false;
  if (chat.channel === 'web') {
    emailed = await maybeEmailWebVisitor({ chat, businessId: req.businessId, text });
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
      emailed,
      suggestion: suggestion ? { id: suggestion._id, question: suggestion.question, answer: suggestion.answer } : null,
    },
  });
});

export const templateSchema = z.object({
  templateName: z.string().min(1, 'Elige una plantilla').max(512),
  languageCode: z.string().min(2).max(10).optional(),
  // Valores de las variables del cuerpo, en orden ({nombre} = nombre del cliente).
  params: z.array(z.string().max(300)).max(10).optional().default([]),
});

/**
 * POST /api/conversations/:id/template — envía una PLANTILLA aprobada. Es la vía
 * para reactivar una conversación de WhatsApp cuya ventana de 24h ya cerró.
 */
export const sendTemplateReply = asyncHandler(async (req, res) => {
  const chat = await ChatSimulation.findOne({ _id: req.params.id, business: req.businessId });
  if (!chat) throw ApiError.notFound('Conversación no encontrada');
  assertChatAccess(req, chat);
  if (chat.channel !== 'whatsapp' || !chat.customerPhone) {
    throw ApiError.badRequest('Las plantillas solo se envían en conversaciones de WhatsApp.');
  }

  const biz = await Business.findById(req.businessId).select('whatsappPhoneNumberId whatsappWabaId');
  // Estructura real de la plantilla: cuántas variables lleva y en qué formato.
  // Mandarla sin sus variables hace que Meta la rechace.
  const listed = biz?.whatsappWabaId ? await listTemplates(biz.whatsappWabaId) : { templates: [] };
  const tpl = (listed.templates || []).find(
    (t) => t.name === req.body.templateName && (!req.body.languageCode || t.language === req.body.languageCode)
  );
  const values = fillPlaceholders(req.body.params, { customerName: chat.customerName });
  const result = await sendTemplate({
    phoneNumberId: biz?.whatsappPhoneNumberId,
    to: chat.customerPhone,
    templateName: req.body.templateName,
    languageCode: req.body.languageCode || tpl?.language || 'es_MX',
    bodyParams: tpl ? bodyParameters(tpl.vars, values, tpl.named) : [],
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
    content: tpl?.bodyText ? renderTemplate(tpl.bodyText, tpl.vars, values) : `Plantilla enviada: ${req.body.templateName}`,
    via: 'agent',
    template: req.body.templateName,
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
  const chat = await ChatSimulation.findOne({ _id: req.params.id, business: req.businessId }).select('channel').lean();
  if (!chat) throw ApiError.notFound('Conversación no encontrada');
  assertChatAccess(req, chat);
  const data = await summarizeConversation({ businessId: req.businessId, chatId: req.params.id });
  res.json({ success: true, data });
});

/** GET /api/conversations/export — descarga las conversaciones en CSV. */
export const exportConversations = asyncHandler(async (req, res) => {
  const chats = await ChatSimulation.find({ business: req.businessId, channel: realChannelFilter(req) })
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
  assertChatAccess(req, chat);

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

/**
 * GET /api/conversations/:id/files/:fileId — descarga un PDF que envió el cliente.
 * Aislado por negocio y por conversación; se sirve como descarga (no se ejecuta
 * en el sitio) y sin caché compartida.
 */
export const downloadAttachment = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.fileId) || !mongoose.isValidObjectId(req.params.id)) {
    throw ApiError.notFound('Archivo no encontrado');
  }
  const owner = await ChatSimulation.findOne({ _id: req.params.id, business: req.businessId }).select('channel').lean();
  if (!owner) throw ApiError.notFound('Archivo no encontrado');
  assertChatAccess(req, owner);
  const att = await ChatAttachment.findOne({
    _id: req.params.fileId,
    chat: req.params.id,
    business: req.businessId,
  });
  if (!att) throw ApiError.notFound('Archivo no encontrado (se borra junto con la conversación).');
  res.set({
    'Content-Type': att.mime === 'application/pdf' ? 'application/pdf' : 'application/octet-stream',
    'Content-Length': String(att.data.length),
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(att.name)}`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.send(att.data);
});
