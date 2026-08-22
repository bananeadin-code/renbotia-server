import mongoose from 'mongoose';

/**
 * Registro append-only del consumo de tokens por Business.
 * Alimenta la gráfica del dashboard y el panel admin (costos reales de la API).
 */
const usageLogSchema = new mongoose.Schema(
  {
    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    date: { type: Date, default: Date.now, index: true },
    inputTokens: { type: Number, default: 0 }, // prompt no cacheado
    outputTokens: { type: Number, default: 0 },
    cacheReadTokens: { type: Number, default: 0 }, // servido desde caché (~0.1x)
    cacheCreationTokens: { type: Number, default: 0 }, // escrito a caché (~1.25x)
    totalTokens: { type: Number, default: 0 }, // input + caché + output (tokens lógicos)
    // Canal que originó el consumo. instagram/facebook quedan listos para Fase 2.
    source: {
      type: String,
      enum: ['simulator', 'whatsapp', 'instagram', 'facebook'],
      default: 'simulator',
    },
    // true = consumo de DEMO/seed (no representa gasto real de la API). Las
    // llamadas reales a Claude lo dejan en false, así el panel admin puede
    // mostrar el COSTO REAL (que debe cuadrar con la consola de Anthropic).
    simulated: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

// Índice compuesto para consultas de consumo por negocio en rango de fechas.
usageLogSchema.index({ business: 1, date: -1 });

export const UsageLog = mongoose.model('UsageLog', usageLogSchema);
