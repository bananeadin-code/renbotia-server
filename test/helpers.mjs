/**
 * Arranque común de las pruebas. IMPORTA ESTE ARCHIVO ANTES que cualquier
 * módulo de src/ (fija el entorno antes de que env.js lo lea).
 *
 * Seguridad:
 *  - Exige TEST_MONGODB_URI y se niega a correr contra Atlas (mongodb.net):
 *    las pruebas crean y BORRAN su propia base.
 *  - Las pruebas con Stripe solo corren con una clave sk_test_ (si no, se omiten).
 */
import crypto from 'node:crypto';

const testUri = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017';
if (/mongodb\.net/i.test(testUri)) {
  throw new Error('TEST_MONGODB_URI apunta a Atlas. Las pruebas solo corren contra un Mongo local o de CI.');
}
// Base única por archivo de prueba (corren en paralelo sin pisarse).
const dbName = `rb_test_${process.pid}_${Date.now()}`;
const hostPart = testUri.replace(/^(mongodb(?:\+srv)?:\/\/[^/?]+).*$/, '$1');
process.env.MONGODB_URI = `${hostPart}/${dbName}`;
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET ||= crypto.randomBytes(32).toString('hex');
process.env.JWT_REFRESH_SECRET ||= crypto.randomBytes(32).toString('hex');
process.env.RESEND_API_KEY = ''; // nunca enviar correos reales
process.env.ALERT_EMAIL = '';
process.env.FOLLOWUP_ENABLED = 'false';
process.env.RENEWALS_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';

const { env } = await import('../src/config/env.js');
if (String(env.stripe.secretKey || '').startsWith('sk_live_')) {
  throw new Error('Hay una clave LIVE de Stripe en el entorno: las pruebas no corren con dinero real.');
}
export const hasStripeTest = String(env.stripe.secretKey || '').startsWith('sk_test_');

const mongoose = (await import('mongoose')).default;
const { PLANS } = await import('../src/config/constants.js');
const { Plan } = await import('../src/models/Plan.js');

export const DAY = 864e5;

/** Conecta a la base de prueba y siembra los planes. */
export async function setupDb() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  await Plan.insertMany(PLANS);
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
}

/** Borra la base de prueba y desconecta. */
export async function teardownDb() {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
}

let seq = 0;
/** Crea un usuario (con contraseña de prueba) y su negocio Free. */
export async function makeOwner(name = 'Dueno', { password = 'PruebaLocal123!' } = {}) {
  const { User } = await import('../src/models/User.js');
  const { provisionBusiness } = await import('../src/services/business.service.js');
  seq += 1;
  const user = new User({
    name,
    email: `${name.toLowerCase()}${seq}.${Date.now()}@test.dev`,
    emailVerified: true,
    twoFactorEnabled: false,
  });
  await user.setPassword(password);
  await user.save();
  const { business } = await provisionBusiness({ owner: user._id, planKey: 'free', business: { name: `Negocio ${name}` } });
  return { user, business, password };
}

/** Stripe de prueba (para preparar tarjetas de prueba directamente). */
export async function stripeTest() {
  const Stripe = (await import('stripe')).default;
  return new Stripe(env.stripe.secretKey);
}
