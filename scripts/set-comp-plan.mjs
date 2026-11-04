/**
 * Plan de CORTESÍA (sin cobro y sin vencimiento) para cuentas internas o de soporte.
 *
 * Pone el plan indicado al negocio del dueño, reinicia su cupo y marca la
 * suscripción como `complimentary`: cada mes se renueva sola SIN cobrar, sin
 * avisos de pago y sin bajar a Free. Conserva los créditos extra comprados.
 *
 * Uso (Shell de Render, con MONGODB_URI en el entorno):
 *   node scripts/set-comp-plan.mjs "correo@ejemplo.com" elite     → activa cortesía Elite
 *   node scripts/set-comp-plan.mjs "correo@ejemplo.com" pro       → cortesía Pro
 *   node scripts/set-comp-plan.mjs "correo@ejemplo.com" off       → quita la cortesía (queda en Free)
 */
import mongoose from 'mongoose';
import { User } from '../src/models/User.js';
import { Business } from '../src/models/Business.js';
import { Subscription } from '../src/models/Subscription.js';
import { Plan } from '../src/models/Plan.js';
import { addMonths } from '../src/utils/dates.js';

const [, , emailArg, modeArg] = process.argv;

function fail(msg) {
  console.error(`\nERROR: ${msg}\n`);
  process.exit(1);
}

if (!process.env.MONGODB_URI) fail('Falta MONGODB_URI en el entorno.');
if (!emailArg || !modeArg) fail('Uso: node scripts/set-comp-plan.mjs "correo@ejemplo.com" elite|pro|off');
const mode = modeArg.trim().toLowerCase();
if (!['elite', 'pro', 'off'].includes(mode)) fail('Opción inválida. Usa: elite, pro u off.');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);

  const user = await User.findOne({ email: emailArg.trim().toLowerCase() });
  if (!user) fail(`No existe un usuario con el correo ${emailArg}.`);
  const business = await Business.findOne({ owner: user._id });
  if (!business) fail('Ese usuario no es dueño de ningún negocio.');
  const sub = await Subscription.findOne({ business: business._id });
  if (!sub) fail('El negocio no tiene suscripción.');

  const plan = await Plan.findOne({ key: mode === 'off' ? 'free' : mode });
  if (!plan) fail('No se encontró el plan en la base.');

  const now = new Date();
  await Subscription.updateOne(
    { _id: sub._id },
    {
      $set: {
        plan: plan._id,
        complimentary: mode !== 'off',
        status: 'activa',
        pendingPlanKey: '',
        currentPeriodStart: now,
        renewalDate: addMonths(now, 1),
        tokensUsedThisPeriod: 0,
        lowBalanceNotified: false,
        renewalAttempts: 0,
        nextRenewalAttemptAt: null,
        pastDueSince: null,
        lastRenewalError: '',
        renewalLockUntil: null,
      },
    }
  );

  console.log(
    mode === 'off'
      ? `\nListo: "${business.name}" quedó en Free y sin cortesía.\n`
      : `\nListo: "${business.name}" tiene plan ${plan.name} de cortesía (sin cobro, se renueva solo cada mes). Créditos extra conservados: ${sub.extraTokens}.\n`
  );
  await mongoose.disconnect();
}

main().catch((err) => fail(err.message));
