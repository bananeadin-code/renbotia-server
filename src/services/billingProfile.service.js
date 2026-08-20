import { BillingProfile } from '../models/BillingProfile.js';
import { Business } from '../models/Business.js';
import { User } from '../models/User.js';
import { createCustomer } from './stripe.service.js';

/** Devuelve el BillingProfile del negocio, creándolo vacío si no existe. */
export async function ensureProfile(businessId) {
  let profile = await BillingProfile.findOne({ business: businessId });
  if (!profile) {
    profile = await BillingProfile.create({ business: businessId });
  }
  return profile;
}

/**
 * Garantiza que el negocio tenga un Customer de Stripe (para guardar tarjetas y
 * cobrar). Lo crea una sola vez y lo persiste en el perfil.
 * @returns {Promise<{ profile, customerId }>}
 */
export async function ensureCustomer(businessId, ownerUserId) {
  const profile = await ensureProfile(businessId);
  if (profile.stripeCustomerId) {
    return { profile, customerId: profile.stripeCustomerId };
  }

  const [business, owner] = await Promise.all([
    Business.findById(businessId).select('name owner'),
    ownerUserId ? User.findById(ownerUserId).select('email name') : null,
  ]);
  const email = owner?.email || undefined;

  const customerId = await createCustomer({
    email,
    name: business?.name || 'Negocio',
    metadata: { businessId: String(businessId) },
  });

  profile.stripeCustomerId = customerId;
  await profile.save();
  return { profile, customerId };
}
