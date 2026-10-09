import crypto from 'node:crypto';
import { Membership } from '../models/Membership.js';
import { Session } from '../models/Session.js';
import { User } from '../models/User.js';
import { Business } from '../models/Business.js';
import { Subscription } from '../models/Subscription.js';
import { Plan } from '../models/Plan.js';
import { addMonths } from '../utils/dates.js';
import { logAudit } from './audit.service.js';
import { sendReferralRewardEmail } from './email.service.js';
import { logger } from '../utils/logger.js';

/**
 * Referidos: al invitar a 3 negocios que se registran con tu enlace y crean su
 * negocio, ganas 1 mes de Pro gratis. Es UN regalo por usuario (no se repite
 * cada 3); después el enlace sigue funcionando, pero ya no da más meses.
 *  - Si estás en Free: tu plan pasa a Pro por un mes y luego vuelve solo a Free
 *    (se programa con pendingPlanKey, sin cobros).
 *  - Si ya pagas Pro o Elite: recibes el equivalente en créditos (el cupo
 *    mensual de Pro), que no caducan.
 * Cuenta como referido quien crea su cuenta con tu enlace Y la usa de verdad:
 * conecta un canal real (WhatsApp, Messenger o Instagram) o paga algo. Crear un
 * negocio vacío ya no basta (evita "invitarse" con cuentas falsas).
 * No cuentan: uno mismo, alguien de tu propio equipo ni cuentas creadas desde tu
 * mismo dispositivo y red.
 *
 * La recompensa es PERSONAL y se aplica al negocio propio de quien invitó, nunca
 * al proyecto donde colabora. Si aún no tiene negocio, queda pendiente y se
 * entrega cuando lo crea.
 */

export const REFERRALS_PER_REWARD = 3;
export const MAX_REWARDS = 1; // el mes de Pro se regala una sola vez
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I para dictarlo fácil

function newCode() {
  const bytes = crypto.randomBytes(7);
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** Código del usuario (se crea la primera vez que lo pide). */
export async function ensureReferralCode(userId) {
  const user = await User.findById(userId).select('referralCode');
  if (!user) return '';
  if (user.referralCode) return user.referralCode;
  for (let i = 0; i < 5; i++) {
    const code = newCode();
    const r = await User.updateOne({ _id: userId, referralCode: { $in: [null, ''] } }, { $set: { referralCode: code } }).catch(
      (err) => (err.code === 11000 ? { modifiedCount: 0, dup: true } : Promise.reject(err))
    );
    if (r.modifiedCount) return code;
    if (!r.dup) break;
  }
  return (await User.findById(userId).select('referralCode').lean())?.referralCode || '';
}

/** Quién refirió a un usuario nuevo (por código). null si no aplica. */
export async function resolveReferrer(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{5,12}$/.test(c)) return null;
  const ref = await User.findOne({ referralCode: c }).select('_id').lean();
  return ref?._id || null;
}

/**
 * Se llama cuando un usuario crea su negocio: si llegó referido, cuenta para quien
 * lo invitó y, si completa otro grupo de 3, se le entrega la recompensa.
 */
export async function qualifyReferral(userId) {
  try {
    const pending = await User.findOne({ _id: userId, referredBy: { $ne: null }, referralQualifiedAt: null })
      .select('referredBy')
      .lean();
    if (!pending?.referredBy || String(pending.referredBy) === String(userId)) return;
    if (await looksLikeSelfReferral(pending.referredBy, userId)) {
      logger.warn(`Referidos: ${userId} no cuenta para ${pending.referredBy} (mismo equipo o mismo dispositivo y red).`);
      await User.updateOne({ _id: userId }, { $set: { referredBy: null } });
      return;
    }
    const user = await User.findOneAndUpdate(
      { _id: userId, referredBy: pending.referredBy, referralQualifiedAt: null },
      { $set: { referralQualifiedAt: new Date() } },
      { new: true }
    ).select('referredBy');
    if (!user) return;
    await maybeReward(user.referredBy);
  } catch (err) {
    logger.warn(`Referidos: no se pudo calificar a ${userId}: ${err.message}`);
  }
}

/**
 * ¿El "referido" es en realidad el mismo que invita o alguien de su equipo?
 *  - es colaborador en el negocio de quien invita, o
 *  - abrió sesión desde el mismo dispositivo (navegador+SO+país) Y la misma IP
 *    que quien invita en los últimos 90 días.
 */
async function looksLikeSelfReferral(referrerId, userId) {
  const owned = await Business.findOne({ owner: referrerId }).select('_id').lean();
  if (owned && (await Membership.exists({ business: owned._id, user: userId }))) return true;
  const since = new Date(Date.now() - 90 * 24 * 3600 * 1000);
  const mine = await Session.find({ user: referrerId, createdAt: { $gte: since } }).select('deviceKey ip').lean();
  if (!mine.length) return false;
  const pairs = new Set(mine.filter((s) => s.deviceKey && s.ip).map((s) => `${s.deviceKey}|${s.ip}`));
  const theirs = await Session.find({ user: userId, createdAt: { $gte: since } }).select('deviceKey ip').lean();
  return theirs.some((s) => pairs.has(`${s.deviceKey}|${s.ip}`));
}

/** Entrega una recompensa que quedó pendiente (p. ej. al crear su negocio). */
export async function applyPendingReward(userId) {
  try {
    await maybeReward(userId);
  } catch (err) {
    logger.warn(`Referidos: recompensa pendiente de ${userId}: ${err.message}`);
  }
}

async function maybeReward(referrerId) {
  // Se aplica a SU negocio propio. Sin negocio todavía: no se consume la
  // recompensa (antes se marcaba como entregada y se perdía); se entrega al
  // crear su negocio (applyPendingReward).
  const ownBusiness = await Business.findOne({ owner: referrerId }).select('_id').lean();
  if (!ownBusiness || !(await Subscription.exists({ business: ownBusiness._id }))) return;
  const qualified = await User.countDocuments({ referredBy: referrerId, referralQualifiedAt: { $ne: null } });
  const earned = Math.min(MAX_REWARDS, Math.floor(qualified / REFERRALS_PER_REWARD));
  // Reclamo atómico de la recompensa pendiente (evita darla dos veces).
  const claim = await User.findOneAndUpdate(
    { _id: referrerId, $expr: { $lt: [{ $ifNull: ['$referralRewards', 0] }, earned] } },
    { $inc: { referralRewards: 1 } },
    { new: true }
  ).select('name email');
  if (!claim) return;

  const business = await Business.findOne({ owner: referrerId }).select('_id name');
  if (!business) return;
  const sub = await Subscription.findOne({ business: business._id }).populate('plan');
  const pro = await Plan.findOne({ key: 'pro' });
  if (!sub || !pro) return;

  let kind;
  if ((sub.plan?.key || 'free') === 'free') {
    // Un mes de Pro y vuelve a Free al renovar (sin cobro).
    const now = new Date();
    sub.plan = pro._id;
    sub.currentPeriodStart = now;
    sub.renewalDate = addMonths(now, 1);
    sub.tokensUsedThisPeriod = 0;
    sub.pendingPlanKey = 'free';
    sub.lowBalanceNotified = false;
    kind = 'trial';
  } else {
    // Ya paga: el mes de Pro llega como créditos que no caducan.
    sub.extraTokens = (sub.extraTokens || 0) + pro.monthlyTokenLimit;
    kind = 'credits';
  }
  await sub.save();

  void logAudit({
    businessId: business._id,
    userId: referrerId,
    action: 'referral.reward',
    summary:
      kind === 'trial'
        ? 'Ganó 1 mes de Pro gratis por invitar a 3 negocios.'
        : 'Ganó un mes de Pro en créditos por invitar a 3 negocios.',
  });
  void sendReferralRewardEmail({ to: claim.email, customerName: claim.name, kind, credits: pro.monthlyTokenLimit });
  logger.info(`Referidos: recompensa (${kind}) para ${referrerId}.`);
}

/** Resumen para el panel. */
export async function referralSummary(userId) {
  const code = await ensureReferralCode(userId);
  const me = await User.findById(userId).select('referralRewards').lean();
  const referred = await User.find({ referredBy: userId })
    .sort({ createdAt: -1 })
    .limit(30)
    .select('name createdAt referralQualifiedAt')
    .lean();
  const qualified = referred.filter((r) => r.referralQualifiedAt).length;
  const totalQualified = await User.countDocuments({ referredBy: userId, referralQualifiedAt: { $ne: null } });
  const mask = (n) => {
    const first = String(n || 'Alguien').trim().split(/\s+/)[0];
    return first.length > 2 ? `${first.slice(0, 1).toUpperCase()}${first.slice(1, 3)}…` : first;
  };
  const rewards = me?.referralRewards || 0;
  const claimed = rewards >= MAX_REWARDS;
  return {
    code,
    qualified: totalQualified,
    pending: referred.length - qualified,
    rewards,
    // Ya recibió su mes de Pro: el regalo no se repite.
    claimed,
    perReward: REFERRALS_PER_REWARD,
    // Avance hacia el regalo (tope en 3) y cuántos faltan.
    progress: Math.min(totalQualified, REFERRALS_PER_REWARD),
    nextIn: claimed ? 0 : Math.max(0, REFERRALS_PER_REWARD - totalQualified),
    recent: referred.slice(0, 10).map((r) => ({
      name: mask(r.name),
      joinedAt: r.createdAt,
      qualified: Boolean(r.referralQualifiedAt),
    })),
  };
}
