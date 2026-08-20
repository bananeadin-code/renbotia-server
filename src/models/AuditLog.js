import mongoose from 'mongoose';

/**
 * Registro de auditoría (append-only): quién cambió qué en un negocio. Importante
 * de cara al multiusuario (varias personas configurando el mismo bot) y al relevo
 * humano (quién tomó el control de una conversación). No se edita ni se borra.
 */
const auditLogSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // quién lo hizo
    action: { type: String, required: true }, // p.ej. 'botconfig.update', 'plan.change'
    summary: { type: String, default: '' }, // descripción legible
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

auditLogSchema.index({ business: 1, createdAt: -1 });

export const AuditLog = mongoose.model('AuditLog', auditLogSchema);
