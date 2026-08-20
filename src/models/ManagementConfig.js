import mongoose from 'mongoose';
import { DEFAULT_MANAGEMENT_CONFIG } from '../config/constants.js';

/**
 * Configuración del módulo de Gestión de un Business (1:1). Solo Elite.
 * Define QUÉ capta el bot (enabledTypes) y la DISPONIBILIDAD (horario semanal,
 * duración de cada espacio, capacidad simultánea, anticipación y horizonte).
 * El motor de disponibilidad lee esto + los registros activos para decidir si un
 * horario está libre. Los espacios se liberan solos cuando la fecha pasa (no hay
 * cron: la ocupación solo cuenta registros futuros y activos).
 */
const daySchema = new mongoose.Schema(
  {
    day: { type: Number, min: 0, max: 6, required: true }, // 0=domingo … 6=sábado
    enabled: { type: Boolean, default: false },
    open: { type: String, default: '09:00' }, // "HH:mm"
    close: { type: String, default: '18:00' },
  },
  { _id: false, id: false }
);

const managementConfigSchema = new mongoose.Schema(
  {
    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      unique: true,
      index: true,
    },
    enabled: { type: Boolean, default: DEFAULT_MANAGEMENT_CONFIG.enabled },
    // Qué tipos de registro capta el bot: cita | reservacion | pedido | prospecto
    enabledTypes: {
      type: [String],
      enum: ['cita', 'reservacion', 'pedido', 'prospecto'],
      default: DEFAULT_MANAGEMENT_CONFIG.enabledTypes,
    },
    slotMinutes: { type: Number, default: DEFAULT_MANAGEMENT_CONFIG.slotMinutes, min: 5, max: 480 },
    // Cuántos registros simultáneos caben en un mismo espacio (mesas, sillas,
    // profesionales…). 1 = agenda de un solo recurso.
    capacityPerSlot: { type: Number, default: DEFAULT_MANAGEMENT_CONFIG.capacityPerSlot, min: 1, max: 100 },
    // Anticipación mínima para agendar (horas desde ahora).
    leadTimeHours: { type: Number, default: DEFAULT_MANAGEMENT_CONFIG.leadTimeHours, min: 0, max: 168 },
    // Cuántos días hacia adelante se puede agendar.
    horizonDays: { type: Number, default: DEFAULT_MANAGEMENT_CONFIG.horizonDays, min: 1, max: 365 },
    schedule: { type: [daySchema], default: DEFAULT_MANAGEMENT_CONFIG.schedule },
    // Fechas bloqueadas (feriados, vacaciones). Se guardan como "YYYY-MM-DD".
    blackoutDates: { type: [String], default: [] },
    timezone: { type: String, default: DEFAULT_MANAGEMENT_CONFIG.timezone },
    // Instrucciones extra para el bot sobre cómo captar trabajo (opcional).
    instructions: { type: String, default: '', maxlength: 2000 },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

export const ManagementConfig = mongoose.model('ManagementConfig', managementConfigSchema);
