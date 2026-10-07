import crypto from 'node:crypto';
import { User } from '../models/User.js';
import { Business } from '../models/Business.js';
import { Subscription } from '../models/Subscription.js';
import { Plan } from '../models/Plan.js';
import { addMonths } from '../utils/dates.js';
import { logAudit } from './audit.service.js';
import { sendReferralRewardEmail } from './email.service.js';
import { logger } from '../utils/logger.js';

/**
 * Referidos: cada 3 negocios que se registran con tu enlace y crean su negocio,
 * ganas 1 mes de Pro gratis.
 *  - Si estás en Free: tu plan pasa a Pro por un mes y luego vuelve solo a Free
 *    (se programa con pendingPlanKey, sin cobros).
 *  - Si ya pagas Pro o Elite: recibes el equivalente en créditos (el cupo
 *    mensual de Pro), que no caducan.
 * Cuenta como referido quien crea su cuenta con tu enlace y termina su registro
 * (crea su negocio). Uno mismo no cuenta.
 */

export const REFERRALS_PER_REWARD = 3;
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
    const user = await User.findOneAndUpdate(
      { _id: userId, referredBy: { $ne: null }, referralQualifiedAt: null },
      { $set: { referralQualifiedAt: new Date() } },
      { new: true }
    ).select('referredBy name');
    if (!user?.referredBy || String(user.referredBy) === String(userId)) return;
    await maybeReward(user.referredBy);
  } catch (err) {
    logger.warn(`Referidos: no se pudo calificar a ${userId}: ${err.message}`);
  }
}

async function maybeReward(referrerId) {
  const qualified = await User.countDocuments({ referredBy: referrerId, referralQualifiedAt: { $ne: null } });
  const earned = Math.floor(qualified / REFERRALS_PER_REWARD);
  // Reclamo atómico de la recompensa pendiente (evita darla dos veces).
  const claim = await User.findOneAndUpdate(
    { _id: referrerId, $expr: { $lt: [{ $ifNull: ['$referralRewards', 0] }, earned] } },
    { $inc: { referralRewards: 1 } },
    { new: true }
  ).select('name email');
  if (!claim) return;

  const business = await Business.findOne({ owner: referrerId }).select('_id name');
  if (!business) return; // sin negocio propio: la recompensa queda contada para cuando lo cree
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
  return {
    code,
    qualified: totalQualified,
    pending: referred.length - qualified,
    rewards: me?.referralRewards || 0,
    perReward: REFERRALS_PER_REWARD,
    nextIn: REFERRALS_PER_REWARD - (totalQualified % REFERRALS_PER_REWARD),
    recent: referred.slice(0, 10).map((r) => ({
      name: mask(r.name),
      joinedAt: r.createdAt,
      qualified: Boolean(r.referralQualifiedAt),
    })),
  };
}
