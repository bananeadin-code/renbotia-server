import mongoose from 'mongoose';
import { ManagementConfig } from '../models/ManagementConfig.js';
import { ManagedRecord } from '../models/ManagedRecord.js';
import { ChatSimulation } from '../models/ChatSimulation.js';
import { CHANNELS, can } from '../config/access.js';
import { logger } from '../utils/logger.js';
import { ApiError } from '../utils/ApiError.js';
import { DEFAULT_MANAGEMENT_CONFIG, RECORD_TYPE_META, ACTIVE_RECORD_STATUSES } from '../config/constants.js';
import { checkSlot } from './availability.service.js';

/**
 * Devuelve la config de gestión del negocio, creándola con valores por defecto
 * si no existe (así el panel siempre tiene algo que mostrar).
 */
export async function ensureConfig(businessId) {
  let config = await ManagementConfig.findOne({ business: businessId });
  if (!config) {
    config = await ManagementConfig.create({
      business: businessId,
      ...DEFAULT_MANAGEMENT_CONFIG,
    });
  }
  return config;
}

/** Actualiza la config (los campos ya vienen validados por Zod en el controller). */
export async function updateConfig(businessId, patch) {
  const config = await ManagementConfig.findOneAndUpdate(
    { business: businessId },
    { $set: patch },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  );
  return config;
}

/**
 * Filtro de registros según el rol (IAM). Con acceso a todos los canales no
 * limita nada. Si el rol solo ve ciertos canales: ve los registros captados en
 * esos canales y los creados a mano (no pertenecen a ningún canal); los de
 * pruebas del simulador solo si puede usar el simulador.
 */
export function recordScope(access) {
  const channels = access?.channels;
  if (!access || !channels || channels === 'all') return {};
  const allowed = CHANNELS.filter((c) => channels.includes(c));
  if (can(access, 'simulator', 'edit')) allowed.push('simulator');
  return { $or: [{ channel: { $in: allowed } }, { source: 'manual', channel: null }] };
}

/**
 * Lista registros con filtros opcionales. Por defecto ordena por relevancia:
 * los agendados por fecha ascendente (próximos primero), el resto por creación.
 */
export async function listRecords(businessId, { type, status, scope, channel } = {}, access = null) {
  const query = { business: businessId, ...recordScope(access) };
  if (type) query.type = type;
  if (status) query.status = status;
  // Filtro por origen: un canal, o 'manual' (creados a mano).
  if (channel === 'manual') query.source = 'manual';
  else if (channel && [...CHANNELS, 'simulator'].includes(channel)) query.channel = channel;

  const now = new Date();
  if (scope === 'upcoming') {
    query.scheduledAt = { $gte: now };
    query.status = query.status || { $in: ACTIVE_RECORD_STATUSES };
  } else if (scope === 'past') {
    query.scheduledAt = { $lt: now };
  }

  const records = await ManagedRecord.find(query)
    .sort({ scheduledAt: 1, createdAt: -1 })
    .limit(500);
  return records;
}

/**
 * Crea un registro. Si es de tipo agendable, valida el espacio contra la
 * disponibilidad salvo que `force` sea true (alta manual del cliente, que puede
 * sobre-agendar a conciencia).
 */
export async function createRecord(businessId, data, { force = false, source = 'manual', chat = null, channel = null } = {}) {
  const meta = RECORD_TYPE_META[data.type];
  if (!meta) throw ApiError.badRequest('Tipo de registro inválido');

  // Registros del bot: guardar el canal de la conversación de origen.
  if (chat && !channel) {
    channel = (await ChatSimulation.findOne({ _id: chat, business: businessId }).select('channel').lean())?.channel || null;
  }

  const record = {
    business: businessId,
    type: data.type,
    status: data.status || 'pendiente',
    customer: { name: data.customer?.name || '', contact: data.customer?.contact || '' },
    quantity: data.quantity || 1,
    summary: data.summary || '',
    notes: data.notes || '',
    details: data.details || {},
    source,
    chat,
    channel,
    scheduledAt: null,
  };

  if (meta.scheduled) {
    if (!data.scheduledAt) throw ApiError.badRequest('Este tipo requiere fecha y hora');
    const config = await ensureConfig(businessId);
    const when = new Date(data.scheduledAt);

    if (!force) {
      const check = await checkSlot(businessId, config, when);
      if (!check.ok) {
        throw new ApiError(409, 'El horario no está disponible', {
          code: 'SLOT_UNAVAILABLE',
          reason: check.reason,
        });
      }
      record.scheduledAt = new Date(check.iso);
    } else {
      record.scheduledAt = when;
    }
  }

  return ManagedRecord.create(record);
}

/** Actualiza un registro del negocio (aislado por tenant). */
export async function updateRecord(businessId, recordId, patch, access = null) {
  // Fuera del alcance del rol = no existe (404), igual que en Conversaciones.
  const record = await ManagedRecord.findOne({ _id: recordId, business: businessId, ...recordScope(access) });
  if (!record) throw ApiError.notFound('Registro no encontrado');

  const fields = ['status', 'summary', 'notes', 'quantity', 'details'];
  for (const f of fields) {
    if (patch[f] !== undefined) record[f] = patch[f];
  }
  if (patch.customer) {
    if (patch.customer.name !== undefined) record.customer.name = patch.customer.name;
    if (patch.customer.contact !== undefined) record.customer.contact = patch.customer.contact;
  }
  // Reagendar (alta manual): se acepta tal cual; el cliente decide.
  if (patch.scheduledAt !== undefined) {
    record.scheduledAt = patch.scheduledAt ? new Date(patch.scheduledAt) : null;
  }

  await record.save();
  return record;
}

export async function deleteRecord(businessId, recordId, access = null) {
  const res = await ManagedRecord.deleteOne({ _id: recordId, business: businessId, ...recordScope(access) });
  if (res.deletedCount === 0) throw ApiError.notFound('Registro no encontrado');
}

/**
 * Métricas para las tarjetas del panel: totales por estado, próximos y captados
 * por el bot.
 */
export async function getStats(businessId, access = null) {
  const now = new Date();
  const scope = recordScope(access);
  const [byStatus, upcoming, byBot, total] = await Promise.all([
    ManagedRecord.aggregate([
      { $match: { business: toObjectId(businessId), ...scope } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    ManagedRecord.countDocuments({
      business: businessId,
      ...scope,
      scheduledAt: { $gte: now },
      status: { $in: ACTIVE_RECORD_STATUSES },
    }),
    ManagedRecord.countDocuments({ business: businessId, ...scope, source: 'bot' }),
    ManagedRecord.countDocuments({ business: businessId, ...scope }),
  ]);

  const status = { pendiente: 0, confirmado: 0, completado: 0, cancelado: 0 };
  for (const row of byStatus) status[row._id] = row.count;

  return { total, upcoming, byBot, status };
}

/**
 * Registros del bot anteriores al campo `channel`: lo toma de su conversación.
 * Idempotente y por lotes; si la conversación ya se borró (30 días sin
 * actividad) el registro queda sin canal y solo se muestra como "bot".
 */
export async function backfillRecordChannels() {
  let fixed = 0;
  for (;;) {
    const batch = await ManagedRecord.find({ source: 'bot', channel: null, chat: { $ne: null }, channelChecked: { $ne: true } })
      .select('chat')
      .limit(500)
      .lean();
    if (!batch.length) break;
    const chats = await ChatSimulation.find({ _id: { $in: batch.map((r) => r.chat) } }).select('channel').lean();
    const byId = new Map(chats.map((c) => [String(c._id), c.channel]));
    await ManagedRecord.bulkWrite(
      batch.map((r) => {
        const channel = byId.get(String(r.chat));
        return {
          updateOne: {
            filter: { _id: r._id },
            // Sin conversación: se marca revisado para no volver a buscarlo.
            update: channel ? { $set: { channel } } : { $set: { channelChecked: true } },
          },
        };
      })
    );
    fixed += batch.filter((r) => byId.get(String(r.chat))).length;
    if (batch.length < 500) break;
  }
  if (fixed) logger.info(`Gestión: canal asignado a ${fixed} registros del bot`);
  return fixed;
}

// Helper: mongoose acepta string, pero aggregate necesita ObjectId.
function toObjectId(id) {
  return id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(id);
}
