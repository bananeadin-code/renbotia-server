import { Business } from '../models/Business.js';
import { User } from '../models/User.js';

/**
 * Equipo (invitar colaboradores) es de Pro/Elite. Excepción temporal para dar
 * soporte: TEAM_FREE_OWNERS en Render con los correos de dueños (separados por
 * coma) cuyo negocio puede invitar aunque esté en Free. Vacío = sin excepciones.
 */
const freeOwners = () =>
  String(process.env.TEAM_FREE_OWNERS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export async function teamUnlockedFor(businessId, planKey) {
  if (planKey === 'pro' || planKey === 'elite') return true;
  const allow = freeOwners();
  if (!allow.length) return false;
  const biz = await Business.findById(businessId).select('owner').lean();
  if (!biz) return false;
  const owner = await User.findById(biz.owner).select('email').lean();
  return Boolean(owner?.email && allow.includes(owner.email.toLowerCase()));
}
