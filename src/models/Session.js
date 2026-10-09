import mongoose from 'mongoose';

/**
 * Sesión de inicio de sesión (una por navegador/dispositivo). Es la fuente de
 * verdad de "¿esta sesión sigue viva?": cerrar sesión, cerrar las demás o un
 * restablecimiento de contraseña la revocan aquí y el acceso se corta en segundos.
 *
 * El refresh token (cookie httpOnly) lleva `sid` + `jti`. En cada renovación el
 * jti ROTA: el anterior deja de valer. Si alguien presenta un jti viejo fuera del
 * margen de gracia, es señal de robo de la cookie → se revoca la sesión y se avisa.
 */
const sessionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Contexto de la sesión (Fase 2: 'owner' | 'member' con su negocio).
    context: {
      kind: { type: String, default: 'account' },
      business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', default: null },
    },
    // Refresh token vigente y el anterior (margen de gracia para pestañas que
    // renuevan al mismo tiempo con la misma cookie).
    jti: { type: String, required: true },
    prevJti: { type: String, default: '' },
    prevValidUntil: { type: Date, default: null },
    // Dispositivo (para que la persona la reconozca).
    device: { type: String, default: '' }, // "Chrome en Windows"
    browser: { type: String, default: '' },
    os: { type: String, default: '' },
    country: { type: String, default: '' }, // código ISO (Cloudflare)
    deviceKey: { type: String, default: '', index: true }, // hash navegador+SO+país
    ip: { type: String, default: '' },
    lastUsedAt: { type: Date, default: Date.now },
    // Vencimiento absoluto (aunque se use a diario).
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: '' }, // logout | user | others | password_reset | reuse | idle | expired | account_deleted
    // Limpieza automática del registro (se conserva un tiempo para detectar
    // dispositivos nuevos y para el historial).
    purgeAt: { type: Date, required: true },
  },
  { timestamps: true }
);

sessionSchema.index({ user: 1, revokedAt: 1 });
sessionSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export const Session = mongoose.model('Session', sessionSchema);
