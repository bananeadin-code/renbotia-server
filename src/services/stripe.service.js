import Stripe from 'stripe';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * Cliente Stripe (modo test). La clave secreta vive SOLO en el backend.
 * Inicialización perezosa para no romper el arranque si aún no está configurada.
 */
let stripe = null;

function getStripe() {
  if (!env.stripe.secretKey) {
    throw new ApiError(503, 'Los pagos no están configurados (falta STRIPE_SECRET_KEY)');
  }
  if (!stripe) {
    stripe = new Stripe(env.stripe.secretKey);
  }
  return stripe;
}

/**
 * Crea una sesión de Checkout (pago único) con line items definidos al vuelo
 * (price_data), así no hay que crear productos en el dashboard de Stripe.
 */
export async function createCheckoutSession({
  itemName,
  amountMXN,
  metadata,
  successUrl,
  cancelUrl,
}) {
  return getStripe().checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [
      {
        price_data: {
          currency: 'mxn',
          product_data: { name: itemName },
          unit_amount: Math.round(amountMXN * 100), // Stripe usa centavos
        },
        quantity: 1,
      },
    ],
    metadata,
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
}

export async function retrieveSession(sessionId) {
  return getStripe().checkout.sessions.retrieve(sessionId);
}

/* ─── Pagos embebidos (PaymentIntent + PaymentElement, sin redirect) ───────── */

/**
 * Crea un PaymentIntent para un pago único (plan o créditos) que se confirma
 * DENTRO del sitio con Stripe Elements, sin redirigir al Checkout de Stripe.
 *
 * Dos modos:
 *  - Tarjeta nueva: se omite `paymentMethodId`. Devuelve un PI en estado
 *    `requires_payment_method`; el navegador lo confirma con <PaymentElement>.
 *  - Tarjeta guardada (cliente presente): se pasa `paymentMethodId` y se
 *    confirma de una vez (on-session). Si Stripe pide 3DS, el PI queda en
 *    `requires_action` y el navegador completa la autenticación.
 *
 * `allow_redirects: 'never'` restringe a métodos sin redirección (tarjeta), para
 * que la experiencia sea siempre embebida.
 *
 * @returns {Promise<import('stripe').Stripe.PaymentIntent>}
 */
export async function createPaymentIntent({
  amountMXN,
  customerId,
  description,
  metadata,
  paymentMethodId,
}) {
  const params = {
    amount: Math.round(amountMXN * 100),
    currency: 'mxn',
    description,
    metadata,
    // Solo tarjeta: evita que Stripe muestre "Link" (checkout acelerado) y otros
    // métodos con redirección. Consistente con el resto de intents del servicio.
    payment_method_types: ['card'],
  };
  if (customerId) params.customer = customerId;
  if (paymentMethodId) {
    params.payment_method = paymentMethodId;
    params.confirm = true;
    params.off_session = false; // el cliente está presente en la compra
  }
  return getStripe().paymentIntents.create(params);
}

export async function retrievePaymentIntent(paymentIntentId) {
  return getStripe().paymentIntents.retrieve(paymentIntentId);
}

/* ─── Tarjeta guardada + cobro automático (Stripe Elements / off-session) ─── */

/**
 * Crea un Customer de Stripe para el negocio (para asociar tarjetas y cobros).
 * @returns {Promise<string>} customerId
 */
export async function createCustomer({ email, name, metadata }) {
  const customer = await getStripe().customers.create({ email, name, metadata });
  return customer.id;
}

/**
 * Crea un SetupIntent: permite guardar una tarjeta para uso futuro OFF-session
 * (recargas automáticas). El cliente lo confirma con Elements en el navegador.
 * @returns {Promise<{ clientSecret: string }>}
 */
export async function createSetupIntent(customerId) {
  const si = await getStripe().setupIntents.create({
    customer: customerId,
    usage: 'off_session',
    payment_method_types: ['card'],
  });
  return { clientSecret: si.client_secret };
}

/** Recupera los datos de display de un PaymentMethod (marca, últimos 4, vencimiento). */
export async function retrievePaymentMethod(paymentMethodId) {
  const pm = await getStripe().paymentMethods.retrieve(paymentMethodId);
  const card = pm.card || {};
  return {
    id: pm.id,
    // Customer al que está asociada (para verificar que la tarjeta es del negocio).
    customer: typeof pm.customer === 'string' ? pm.customer : pm.customer?.id || '',
    brand: card.brand || '',
    last4: card.last4 || '',
    expMonth: card.exp_month || 0,
    expYear: card.exp_year || 0,
  };
}

/**
 * Fija la tarjeta como método de pago por defecto del Customer (para off-session).
 */
export async function setDefaultPaymentMethod(customerId, paymentMethodId) {
  await getStripe().customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });
}

/** Desasocia (elimina) una tarjeta guardada. */
export async function detachPaymentMethod(paymentMethodId) {
  try {
    await getStripe().paymentMethods.detach(paymentMethodId);
  } catch (err) {
    // Si ya no existe en Stripe, seguimos: el objetivo es dejar de tenerla.
    if (err?.statusCode !== 404) throw err;
  }
}

/**
 * Elimina por completo el Customer de Stripe. Al borrarlo, Stripe desasocia y
 * elimina también sus PaymentMethods (la tarjeta guardada). Se usa al eliminar
 * la cuenta del usuario, para no dejar rastro suyo en Stripe. Best-effort: si los
 * pagos no están configurados o el Customer ya no existe, no rompe el borrado.
 */
export async function deleteCustomer(customerId) {
  if (!customerId || !env.stripe.secretKey) return;
  try {
    await getStripe().customers.del(customerId);
  } catch (err) {
    if (err?.statusCode !== 404) throw err;
  }
}

/**
 * Cobra OFF-SESSION contra una tarjeta guardada (recarga automática). El cliente
 * no está presente. Devuelve el PaymentIntent o lanza un error tipado con el
 * motivo (tarjeta rechazada, requiere autenticación 3DS, etc.).
 * @returns {Promise<{ id, status }>}
 */
export async function chargeOffSession({
  customerId,
  paymentMethodId,
  amountMXN,
  description,
  metadata,
  idempotencyKey,
}) {
  const stripe = getStripe();
  try {
    const pi = await stripe.paymentIntents.create(
      {
        amount: Math.round(amountMXN * 100),
        currency: 'mxn',
        customer: customerId,
        payment_method: paymentMethodId,
        payment_method_types: ['card'],
        off_session: true,
        confirm: true,
        description,
        metadata,
      },
      // Idempotencia: si la misma petición se repite (reintento de red, proceso
      // reiniciado), Stripe devuelve el MISMO cobro en vez de cobrar dos veces.
      idempotencyKey ? { idempotencyKey } : undefined
    );
    return { id: pi.id, status: pi.status };
  } catch (err) {
    // Stripe expone el motivo en err.code (p.ej. 'authentication_required',
    // 'card_declined'). Lo propagamos para que el llamador reaccione/notifique.
    const e = new Error(err?.message || 'No se pudo cobrar la tarjeta.');
    e.stripeCode = err?.code || err?.decline_code || 'charge_failed';
    e.paymentIntentId = err?.raw?.payment_intent?.id || err?.payment_intent?.id || '';
    throw e;
  }
}

/**
 * Busca un cobro YA exitoso del Customer cuya metadata[key] === value (p. ej. la
 * renovación de un periodo concreto). Sirve para reconciliar: si el proceso se
 * cayó después de cobrar y antes de registrar el pago, no se vuelve a cobrar.
 * @returns {Promise<{ id: string, amount: number } | null>}
 */
export async function findSucceededIntent({ customerId, key, value, sinceDate }) {
  if (!customerId) return null;
  const params = { customer: customerId, limit: 50 };
  if (sinceDate) params.created = { gte: Math.floor(new Date(sinceDate).getTime() / 1000) };
  const list = await getStripe().paymentIntents.list(params);
  const pi = list.data.find((p) => p.status === 'succeeded' && p.metadata?.[key] === value);
  return pi ? { id: pi.id, amount: pi.amount } : null;
}
