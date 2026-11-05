import mongoose from 'mongoose';

/**
 * Seguimiento comercial (CRM) de cada registro: quién del equipo lo atiende, en
 * qué etapa manual va (las etapas automáticas salen de los datos: verificó,
 * creó negocio, conectó canal, pagó) y sus notas.
 */
export const LEAD_STAGES = ['nuevo', 'contactado', 'llamada_agendada', 'en_seguimiento', 'ganado', 'perdido'];

const noteSchema = new mongoose.Schema(
  {
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, default: '' },
    text: { type: String, required: true, maxlength: 1000 },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

const leadSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    stage: { type: String, enum: LEAD_STAGES, default: 'nuevo', index: true },
    assignee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    phone: { type: String, default: '', maxlength: 30 },
    nextFollowUpAt: { type: Date, default: null, index: true },
    lostReason: { type: String, default: '', maxlength: 300 },
    notes: { type: [noteSchema], default: [] },
    // Primer contacto del equipo (para medir qué tan rápido se atiende).
    firstContactAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const Lead = mongoose.model('Lead', leadSchema);
