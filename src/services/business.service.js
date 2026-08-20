import { Business } from '../models/Business.js';
import { Subscription } from '../models/Subscription.js';
import { BotConfig } from '../models/BotConfig.js';
import { Membership } from '../models/Membership.js';
import { Plan } from '../models/Plan.js';
import { ApiError } from '../utils/ApiError.js';
import { BUSINESS_STATUS } from '../config/constants.js';
import { addMonths } from '../utils/dates.js';

/**
 * Aprovisiona un negocio completo para un usuario: Business + Subscription
 * (con renovación a 1 mes) + BotConfig inicial. Es idempotente por usuario en
 * el MVP (1 usuario = 1 negocio): si ya tiene negocio, lo devuelve.
 *
 * Reutilizable desde:
 *  - el seed (datos demo)
 *  - el webhook/confirmación de Stripe al completar el checkout (Fase 5)
 */
export async function provisionBusiness({
  owner,
  planKey,
  business = {},
  botConfig = {},
  stripeSessionId = '',
}) {
  const existing = await Business.findOne({ owner });
  if (existing) {
    return loadBusinessBundle(existing._id);
  }

  const plan = await Plan.findOne({ key: planKey, isActive: true });
  if (!plan) {
    throw ApiError.badRequest(`Plan inválido: ${planKey}`);
  }

  const createdBusiness = await Business.create({
    owner,
    name: business.name || 'Mi negocio',
    industry: business.industry || 'otro',
    industryOther: business.industry === 'otro' ? business.industryOther || '' : '',
    whatsappNumber: business.whatsappNumber || '',
    status: BUSINESS_STATUS.ACTIVO,
  });

  // El dueño obtiene su membresía 'owner' (base del multiusuario).
  await Membership.create({ business: createdBusiness._id, user: owner, role: 'owner' });

  const now = new Date();
  await Subscription.create({
    business: createdBusiness._id,
    plan: plan._id,
    currentPeriodStart: now,
    renewalDate: addMonths(now, 1),
    tokensUsedThisPeriod: 0,
    extraTokens: 0,
    stripeSessionId,
  });

  await BotConfig.create({
    business: createdBusiness._id,
    botName: botConfig.botName || 'Asistente',
    tone: botConfig.tone || 'cercano',
    systemPrompt: botConfig.systemPrompt || '',
    faqs: botConfig.faqs || [],
    businessInfo: botConfig.businessInfo || {},
  });

  return loadBusinessBundle(createdBusiness._id);
}

/**
 * Carga el paquete completo de un negocio (business + subscription+plan + botConfig).
 */
export async function loadBusinessBundle(businessId) {
  const [business, subscription, botConfig] = await Promise.all([
    Business.findById(businessId),
    Subscription.findOne({ business: businessId }).populate('plan'),
    BotConfig.findOne({ business: businessId }),
  ]);
  return { business, subscription, botConfig };
}
