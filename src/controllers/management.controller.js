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
} from '../services/management.service.js';
import { getAvailableSlots, getAvailabilityRange } from '../services/availability.service.js';

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
  enabledTypes: z.array(z.enum(RECORD_TYPES)).optional(),
  slotMinutes: z.number().int().min(5).max(480).optional(),
  capacityPerSlot: z.number().int().min(1).max(100).optional(),
  leadTimeHours: z.number().int().min(0).max(168).optional(),
  horizonDays: z.number().int().min(1).max(365).optional(),
  schedule: z.array(daySchema).length(7).optional(),
  blackoutDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  instructions: z.string().max(2000).optional(),
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

export const createRecordSchema = z.object({
  type: z.enum(RECORD_TYPES),
  status: z.enum(RECORD_STATUSES).optional(),
  customer: customerSchema.optional(),
  scheduledAt: z.string().datetime({ offset: true }).or(z.string().min(10)).optional(),
  quantity: z.number().int().min(1).max(1000).optional(),
  summary: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
  details: z.record(z.any()).optional(),
  force: z.boolean().optional(),
});

export const updateRecordSchema = z.object({
  status: z.enum(RECORD_STATUSES).optional(),
  customer: customerSchema.optional(),
  scheduledAt: z.string().min(10).nullable().optional(),
  quantity: z.number().int().min(1).max(1000).optional(),
  summary: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
  details: z.record(z.any()).optional(),
});

export const listRecordsHandler = asyncHandler(async (req, res) => {
  const { type, status, scope } = req.query;
  const records = await listRecords(req.businessId, { type, status, scope });
  res.json({ success: true, data: { records } });
});

export const createRecordHandler = asyncHandler(async (req, res) => {
  const { force, ...data } = req.body;
  // Alta manual del cliente: puede forzar (sobre-agendar) a conciencia.
  const record = await createRecord(req.businessId, data, { force: force ?? true, source: 'manual' });
  res.status(201).json({ success: true, data: { record } });
});

export const updateRecordHandler = asyncHandler(async (req, res) => {
  const record = await updateRecord(req.businessId, req.params.id, req.body);
  res.json({ success: true, data: { record } });
});

export const deleteRecordHandler = asyncHandler(async (req, res) => {
  await deleteRecord(req.businessId, req.params.id);
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
  const stats = await getStats(req.businessId);
  res.json({ success: true, data: { stats } });
});
