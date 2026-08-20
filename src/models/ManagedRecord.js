import mongoose from 'mongoose';

/**
 * Registro de trabajo captado por el bot o creado a mano por el cliente:
 * una cita, reservación, pedido o prospecto. Motor GENÉRICO: los datos
 * específicos de cada vertical viven en `details` (mixto) para no atarnos a un
 * esquema rígido; los campos de primer nivel son los comunes a todos.
 *
 * Ocupación de agenda: un registro "ocupa" un espacio si es de tipo agendable
 * (cita/reservacion), tiene `scheduledAt` futuro y su estado está activo
 * (pendiente|confirmado). Cuando la fecha pasa, deja de contar automáticamente
 * → el espacio se libera sin ninguna tarea programada.
 */
const managedRecordSchema = new mongoose.Schema(
  {
    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['cita', 'reservacion', 'pedido', 'prospecto'],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['pendiente', 'confirmado', 'completado', 'cancelado'],
      default: 'pendiente',
      index: true,
    },
    customer: {
      name: { type: String, default: '', trim: true },
      contact: { type: String, default: '', trim: true }, // teléfono/WhatsApp/email
    },
    // Momento agendado (citas/reservaciones). null en pedidos/prospectos.
    scheduledAt: { type: Date, default: null, index: true },
    // Nº de personas (reservaciones) o unidades relevantes. Cuenta para capacidad.
    quantity: { type: Number, default: 1, min: 1 },
    // Título corto legible (ej. "Consulta legal", "Mesa para 4", "Pedido #3").
    summary: { type: String, default: '', trim: true },
    notes: { type: String, default: '', trim: true },
    // Datos específicos de la vertical (servicio, items del pedido, etc.).
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Origen: 'bot' (captado en conversación) | 'manual' (creado por el cliente).
    source: { type: String, enum: ['bot', 'manual'], default: 'manual', index: true },
    // Conversación del simulador que lo generó (si vino del bot).
    chat: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatSimulation', default: null },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

// Consulta típica: ocupación por negocio en un rango de fechas y estados.
managedRecordSchema.index({ business: 1, type: 1, scheduledAt: 1, status: 1 });

export const ManagedRecord = mongoose.model('ManagedRecord', managedRecordSchema);
