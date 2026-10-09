import mongoose from 'mongoose';

/**
 * Membresía: relación usuario ↔ negocio con un rol. Permite que varias personas
 * accedan y configuren el mismo bot (multiusuario) sin compartir contraseñas.
 *  - owner: control total (incluye facturación y gestión de miembros).
 *  - colaborador: configura el bot, simulador, gestión y datos del negocio;
 *    NO toca facturación ni miembros.
 * El dueño original del negocio tiene una membresía 'owner'.
 */
const membershipSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role: { type: String, enum: ['owner', 'colaborador'], default: 'colaborador' },
    // Rol del colaborador (Fase 3): 'admin' | 'agent' | 'readonly' (listos),
    // 'role:<id>' (rol personalizado del negocio) o 'custom' (acceso propio en
    // `access`). Vacío = permisos de antes (los 4 interruptores de abajo).
    roleKey: { type: String, default: '' },
    access: {
      modules: { type: mongoose.Schema.Types.Mixed, default: undefined },
      channels: { type: mongoose.Schema.Types.Mixed, default: undefined },
    },
    // Permisos de antes de los roles (se conservan para migrar sin cambios).
    permissions: {
      simulator: { type: Boolean, default: true },
      training: { type: Boolean, default: true },
      profile: { type: Boolean, default: false },
      connections: { type: Boolean, default: false },
    },
  },
  { timestamps: true }
);

// Un usuario no puede tener dos membresías en el mismo negocio.
membershipSchema.index({ business: 1, user: 1 }, { unique: true });

export const Membership = mongoose.model('Membership', membershipSchema);
