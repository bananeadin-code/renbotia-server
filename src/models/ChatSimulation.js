import mongoose from 'mongoose';
import { CONVERSATION_RETENTION_DAYS } from '../config/constants.js';

const messageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    tokens: { type: Number, default: 0 },
    // Quién generó un mensaje de assistant: el bot o una persona (agente) que
    // tomó el control. Para role 'user' no aplica (es el cliente).
    via: { type: String, enum: ['bot', 'agent'], default: 'bot' },
    // Imágenes que el bot adjuntó en este mensaje (Elite): {label, url}.
    images: {
      type: [{ label: String, url: String }],
      default: undefined,
    },
    // Calificación de calidad que el dueño/agente da a una respuesta del bot
    // ('up' buena / 'down' mala). Sirve para detectar respuestas a mejorar.
    rating: { type: String, enum: ['up', 'down', null], default: null },
    // Archivos que mandó el cliente (PDF). El contenido vive en ChatAttachment;
    // aquí solo lo necesario para mostrarlo y descargarlo desde la bandeja.
    files: {
      type: [{ id: mongoose.Schema.Types.ObjectId, name: String, mime: String, size: Number }],
      default: undefined,
    },
    // Mensaje de seguimiento automático (el cliente había dejado de responder).
    followUp: { type: Boolean, default: undefined },
    // Nombre de la plantilla de WhatsApp con la que salió este mensaje (si aplica).
    template: { type: String, default: undefined },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

/**
 * Historial del simulador de WhatsApp. Cada documento es una "conversación de
 * prueba" que el cliente puede revisar después. Aislado por Business.
 */
const chatSimulationSchema = new mongoose.Schema(
  {
    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    title: { type: String, default: 'Nueva conversación' },
    // Canal de origen. 'simulator' (pruebas del panel) y 'whatsapp' (Cloud API) son
    // los activos hoy; 'instagram' y 'facebook' quedan listos para la Fase 2
    // multicanal (misma infra de Meta Graph API → solo se agrega su adaptador).
    channel: {
      type: String,
      enum: ['simulator', 'whatsapp', 'instagram', 'facebook', 'web'],
      default: 'simulator',
    },
    // Datos del cliente real (vacíos en el simulador).
    customerPhone: { type: String, default: '' }, // wa_id de WhatsApp (dígitos)
    // Identificador GENÉRICO del cliente por canal (channel-agnostic): wa_id en
    // WhatsApp, PSID/IGSID en Instagram/Messenger. Lo usa el adaptador de cada canal.
    customerId: { type: String, default: '' },
    customerName: { type: String, default: '' },
    // Quién del equipo abrió esta prueba del simulador (control de uso y tokens).
    startedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Correo o WhatsApp que dejó el visitante del widget web (captura de prospectos).
    customerContact: { type: String, default: '' },
    messages: { type: [messageSchema], default: [] },
    // Relevo humano: 'bot' = el bot responde automáticamente; 'manual' = una
    // persona tomó el control y el bot no responde en esta conversación.
    handoffMode: { type: String, enum: ['bot', 'manual'], default: 'bot' },
    // El bot marcó la conversación para que la atienda una persona.
    needsAttention: { type: Boolean, default: false },
    attentionReason: { type: String, default: '' },
    // Tipo del ÚLTIMO registro de trabajo captado en esta conversación
    // (cita/reservacion/pedido/prospecto), o '' si no captó ninguno. Sirve para
    // marcar en la bandeja las conversaciones que generaron trabajo.
    capturedRecordType: { type: String, default: '' },
    // Etiquetas que el agente pone para organizar (venta, soporte, pendiente…).
    tags: { type: [String], default: [] },
    // Lead caliente: el bot detectó ALTA intención de compra/contratación (el
    // cliente está listo o muy interesado). Se resalta en la bandeja para dar
    // seguimiento prioritario. Es una OPORTUNIDAD de venta — distinto de
    // needsAttention (queja/urgencia/algo que el bot no resolvió).
    hotLead: { type: Boolean, default: false },
    hotLeadReason: { type: String, default: '' },
    hotLeadAt: { type: Date, default: null },
    // Último seguimiento automático enviado. Solo se manda uno por cada silencio
    // del cliente (se vuelve a permitir cuando el cliente escribe de nuevo).
    followUpAt: { type: Date, default: null },
    // Último seguimiento con PLANTILLA (WhatsApp, ventana de 24 h ya cerrada).
    // Uno por silencio del cliente, igual que followUpAt.
    templateFollowUpAt: { type: Date, default: null },
    // Widget web: última vez que el visitante tenía el chat abierto (sondeo) y
    // último aviso por correo de una respuesta del equipo (anti-spam).
    webLastSeenAt: { type: Date, default: null },
    webReplyEmailAt: { type: Date, default: null },
    // Sitio donde está el widget (para el enlace del correo al visitante).
    webOrigin: { type: String, default: '' },
  },
  { timestamps: true }
);

// Ubicar rápido la conversación abierta de un cliente de WhatsApp por su teléfono.
chatSimulationSchema.index({ business: 1, channel: 1, customerPhone: 1 });

// Canales sin teléfono (Messenger por PSID, widget web por sesión).
chatSimulationSchema.index({ business: 1, channel: 1, customerId: 1 });

// Bandeja: conversaciones de un negocio por actividad reciente (sin ordenar en memoria).
chatSimulationSchema.index({ business: 1, updatedAt: -1 });

// Retención: MongoDB borra solo las conversaciones sin actividad (updatedAt) por
// más de CONVERSATION_RETENTION_DAYS. Cada mensaje nuevo actualiza updatedAt.
chatSimulationSchema.index(
  { updatedAt: 1 },
  { expireAfterSeconds: CONVERSATION_RETENTION_DAYS * 24 * 60 * 60 }
);

export const ChatSimulation = mongoose.model('ChatSimulation', chatSimulationSchema);
