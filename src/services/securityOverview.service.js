import { User } from '../models/User.js';
import { Business } from '../models/Business.js';
import { Membership } from '../models/Membership.js';
import { Passkey } from '../models/Passkey.js';
import { listSessions } from './session.service.js';

/**
 * "Tu seguridad" (Perfil): un resumen amable de qué tan protegida está la
 * cuenta y qué se puede reforzar. Nada es obligatorio: los pasos opcionales se
 * muestran como sugerencias, no como alertas.
 */

const WEIGHTS = { verificacion: 50, llave: 25, sesiones: 15, equipo: 10 };

export function levelOf(score) {
  if (score >= 85) return { key: 'muy_buena', label: 'Muy buena' };
  if (score >= 60) return { key: 'buena', label: 'Buena' };
  return { key: 'basica', label: 'Básica' };
}

export async function securityOverview(userId, currentSid) {
  const user = await User.findById(userId).select('+passwordHash +googleId').lean();
  const [passkeys, sessions, owned] = await Promise.all([
    Passkey.countDocuments({ user: userId }),
    listSessions(userId, currentSid),
    Business.findOne({ owner: userId }).select('security ownerWhatsApp').lean(),
  ]);
  const team = owned ? await Membership.countDocuments({ business: owned._id, role: { $ne: 'owner' } }) : 0;
  const googleOnly = Boolean(user.googleId && !user.passwordHash);

  const checks = [
    {
      id: 'verificacion',
      ok: Boolean(user.twoFactorEnabled) || googleOnly,
      title: 'Verificación en dos pasos',
      detail: googleOnly
        ? 'Entras con Google: tu cuenta de Google te protege.'
        : user.twoFactorEnabled
          ? 'Al entrar con contraseña en un dispositivo nuevo te pedimos un código.'
          : 'Solo tu contraseña protege tu cuenta. Enciéndela: es un código por correo al entrar en un dispositivo nuevo.',
      href: '#dos-pasos',
      optional: false,
    },
    {
      id: 'llave',
      ok: passkeys > 0,
      title: 'Llave de acceso',
      detail: passkeys > 0 ? `Tienes ${passkeys} ${passkeys === 1 ? 'llave' : 'llaves'}: entras con huella, cara o PIN.` : 'Entra con tu huella, cara o PIN: más rápido y a prueba de sitios falsos.',
      href: '#llaves',
      optional: true,
    },
    {
      id: 'sesiones',
      ok: sessions.length <= 5,
      title: 'Dispositivos con tu cuenta abierta',
      detail:
        sessions.length <= 5
          ? `${sessions.length} ${sessions.length === 1 ? 'dispositivo' : 'dispositivos'}. Si ves uno que no reconoces, ciérralo.`
          : `Tienes ${sessions.length} dispositivos con la cuenta abierta. Revisa y cierra los que ya no uses.`,
      href: '#sesiones',
      optional: false,
    },
  ];
  if (team > 0) {
    checks.push({
      id: 'equipo',
      ok: Boolean(owned.security?.requireTeam2fa),
      title: 'Verificación para tu equipo',
      detail: owned.security?.requireTeam2fa
        ? 'Tus colaboradores confirman con un código para entrar a tu negocio.'
        : `Pide un código a ${team === 1 ? 'tu colaborador' : `tus ${team} colaboradores`} al entrar a tu negocio.`,
      href: '/dashboard/equipo',
      optional: true,
    });
  }

  const max = checks.reduce((n, c) => n + WEIGHTS[c.id], 0) + (team > 0 ? 0 : WEIGHTS.equipo);
  const got = checks.filter((c) => c.ok).reduce((n, c) => n + WEIGHTS[c.id], 0) + (team > 0 ? 0 : WEIGHTS.equipo);
  const score = Math.round((got / max) * 100);

  return {
    score,
    level: levelOf(score),
    checks,
    ownerWhatsApp: (owned?.ownerWhatsApp || []).length,
    recent: sessions.slice(0, 4).map((s) => ({
      device: s.device,
      place: s.place,
      lastUsedAt: s.lastUsedAt,
      createdAt: s.createdAt,
      current: s.current,
    })),
  };
}
