import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  ensureConfig,
  updateConfig,
  listRecords,
  createRecord,
  updateRecord,
  deleteRecord,
  getStats,
  recordScope,
} from '../services/management.service.js';
import { getAvailableSlots, getAvailabilityRange } from '../services/availability.service.js';
import { ManagedRecord } from '../models/ManagedRecord.js';
import { toXlsx, sendXlsx } from '../utils/xlsx.js';
import { formatPhoneDisplay } from '../utils/phone.js';

const RECORD_TYPES = ['cita', 'reservacion', 'pedido', 'prospecto'];
const RECORD_STATUSES = ['pendiente', 'confirmado', 'completado', 'cancelado'];

/* ─── Config ─────────────────────────────────────────────────────────────── */

const daySchema = z.object({
  day: z.number().int().min(0).max(6),
  enabled: z.boolean(),
  open: z.string().regex(/^\d{2}:\d{2}$/, 'Hora inválida (HH:mm)'),
  close: z.string().regex(/^\d{2}:\d{2}$/, 'Hora inválida (HH:mm)'),
});

export const updateConfigSchema = z.object({
  enabled: z.boolean().optional(),
  enabledTypes: z.array(z.enum(RECORD_TYPES)).max(RECORD_TYPES.length).optional(),
  slotMinutes: z.number().int().min(5).max(480).optional(),
  capacityPerSlot: z.number().int().min(1).max(100).optional(),
  leadTimeHours: z.number().int().min(0).max(168).optional(),
  horizonDays: z.number().int().min(1).max(365).optional(),
  schedule: z.array(daySchema).length(7).optional(),
  blackoutDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(366).optional(),
  instructions: z.string().max(2000).optional(),
  reminders: z
    .object({
      enabled: z.boolean(),
      hoursBefore: z.union([z.literal(2), z.literal(4), z.literal(12), z.literal(24), z.literal(48)]),
      template: z
        .object({
          name: z.string().max(512).regex(/^[a-z0-9_]*$/, 'Nombre de plantilla no válido'),
          language: z.string().max(15),
          params: z.array(z.string().max(300)).max(10),
        })
        .optional(),
    })
    .optional(),
});

export const getConfig = asyncHandler(async (req, res) => {
  const config = await ensureConfig(req.businessId);
  res.json({ success: true, data: { config } });
});

export const putConfig = asyncHandler(async (req, res) => {
  const config = await updateConfig(req.businessId, req.body);
  res.json({ success: true, data: { config } });
});

/* ─── Registros ──────────────────────────────────────────────────────────── */

const customerSchema = z.object({
  name: z.string().max(120).optional(),
  contact: z.string().max(120).optional(),
});

// Datos libres del registro (los llena el bot o el equipo): acotados en tamaño.
const detailsSchema = z
  .record(z.any())
  .refine((d) => Object.keys(d).length <= 30 && JSON.stringify(d).length <= 5000, 'Los detalles son demasiado largos.');

export const createRecordSchema = z.object({
  type: z.enum(RECORD_TYPES),
  status: z.enum(RECORD_STATUSES).optional(),
  customer: customerSchema.optional(),
  scheduledAt: z.string().datetime({ offset: true }).or(z.string().min(10)).optional(),
  quantity: z.number().int().min(1).max(1000).optional(),
  summary: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
  details: detailsSchema.optional(),
  force: z.boolean().optional(),
});

export const updateRecordSchema = z.object({
  status: z.enum(RECORD_STATUSES).optional(),
  customer: customerSchema.optional(),
  scheduledAt: z.string().min(10).nullable().optional(),
  quantity: z.number().int().min(1).max(1000).optional(),
  summary: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
  details: detailsSchema.optional(),
});

export const listRecordsHandler = asyncHandler(async (req, res) => {
  const { type, status, scope, channel } = req.query;
  const records = await listRecords(req.businessId, { type, status, scope, channel }, req.access);
  res.json({ success: true, data: { records } });
});

export const createRecordHandler = asyncHandler(async (req, res) => {
  const { force, ...data } = req.body;
  // Alta manual del cliente: puede forzar (sobre-agendar) a conciencia.
  const record = await createRecord(req.businessId, data, { force: force ?? true, source: 'manual' });
  res.status(201).json({ success: true, data: { record } });
});

export const updateRecordHandler = asyncHandler(async (req, res) => {
  const record = await updateRecord(req.businessId, req.params.id, req.body, req.access);
  res.json({ success: true, data: { record } });
});

export const deleteRecordHandler = asyncHandler(async (req, res) => {
  await deleteRecord(req.businessId, req.params.id, req.access);
  res.json({ success: true, data: { deleted: true } });
});

/* ─── Disponibilidad y métricas ──────────────────────────────────────────── */

export const availabilityHandler = asyncHandler(async (req, res) => {
  const config = await ensureConfig(req.businessId);
  const { date, days } = req.query;
  if (date) {
    const slots = await getAvailableSlots(req.businessId, config, date);
    return res.json({ success: true, data: { date, slots } });
  }
  const range = await getAvailabilityRange(req.businessId, config, Number(days) || 7);
  res.json({ success: true, data: { range } });
});

export const statsHandler = asyncHandler(async (req, res) => {
  const stats = await getStats(req.businessId, req.access);
  res.json({ success: true, data: { stats } });
});

const CHANNEL_LABEL = { whatsapp: 'WhatsApp', facebook: 'Messenger', instagram: 'Instagram', web: 'Sitio web', simulator: 'Simulador' };

const TYPE_NAME = { cita: 'Cita', reservacion: 'Reservación', pedido: 'Pedido', prospecto: 'Prospecto' };
const STATUS_NAME = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

/** GET /api/management/export — Excel con los registros (citas, pedidos, prospectos). */
export const exportRecords = asyncHandler(async (req, res) => {
  const records = await ManagedRecord.find({ business: req.businessId, ...recordScope(req.access) })
    .sort({ createdAt: -1 })
    .limit(5000)
    .lean();

  const xlsx = toXlsx(
    records,
    [
      { label: 'Creado', type: 'date', width: 17, get: (r) => r.createdAt },
      { label: 'Tipo', width: 13, get: (r) => TYPE_NAME[r.type] || r.type || '' },
      { label: 'Estado', width: 13, get: (r) => STATUS_NAME(r.status) },
      { label: 'Cliente', width: 24, get: (r) => r.customer?.name || '' },
      { label: 'Contacto', width: 20, get: (r) => formatPhoneDisplay(r.customer?.contact) },
      { label: 'Agendado', type: 'date', width: 17, get: (r) => r.scheduledAt || '' },
      { label: 'Cantidad', type: 'number', width: 10, get: (r) => r.quantity ?? '' },
      { label: 'Resumen', type: 'wrap', width: 40, get: (r) => r.summary || '' },
      { label: 'Notas', type: 'wrap', width: 40, get: (r) => r.notes || '' },
      { label: 'Origen', width: 10, get: (r) => (r.source === 'bot' ? 'Bot' : 'Manual') },
      { label: 'Canal', width: 12, get: (r) => CHANNEL_LABEL[r.channel] || (r.source === 'manual' ? 'Manual' : '') },
    ],
    'Registros'
  );
  sendXlsx(res, xlsx, 'registros-renbotia.xlsx');
});
