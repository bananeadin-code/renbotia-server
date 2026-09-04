/**
 * Cambia el plan de un negocio de INMEDIATO (para pruebas / soporte).
 *
 * Actualiza la suscripción del negocio del dueño indicado: apunta al plan
 * elegido, reinicia el consumo del periodo y fija nueva renovación (+1 mes).
 * NO cobra nada. Conserva los créditos extra comprados (extraTokens).
 *
 * Uso (Shell de Render, con MONGODB_URI en el entorno):
 *   node scripts/set-plan.mjs "correo@ejemplo.com" elite
 *   node scripts/set-plan.mjs "correo@ejemplo.com" free|pro|elite
 */
import mongoose from 'mongoose';
import { User } from '../src/models/User.js';
import { Business } from '../src/models/Business.js';
import { Subscription } from '../src/models/Subscription.js';
import { Plan } from '../src/models/Plan.js';
import { addMonths } from '../src/utils/dates.js';

const [, , emailArg, planKeyArg] = process.argv;
const MONGODB_URI = process.env.MONGODB_URI;

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

if (!MONGODB_URI) fail('Falta MONGODB_URI en el entorno.');
if (!emailArg || !planKeyArg) {
  fail('Uso: node scripts/set-plan.mjs "correo@ejemplo.com" free|pro|elite');
}
const planKey = planKeyArg.trim().toLowerCase();
if (!['free', 'pro', 'elite'].includes(planKey)) {
  fail('Plan inválido. Usa: free, pro o elite.');
}

async function main() {
  await mongoose.connect(MONGODB_URI);

  const user = await User.findOne({ email: emailArg.trim().toLowerCase() });
  if (!user) fail(`No existe un usuario con el correo ${emailArg}.`);

  const business = await Business.findOne({ owner: user._id });
  if (!business) fail(`El usuario ${emailArg} no tiene un negocio.`);

  const plan = await Plan.findOne({ key: planKey });
  if (!plan) fail(`No existe el plan "${planKey}" en la base (¿corriste bootstrap-admin/seed?).`);

  const now = new Date();
  const sub = await Subscription.findOneAndUpdate(
    { business: business._id },
    {
      plan: plan._id,
      status: 'activa',
      currentPeriodStart: now,
      renewalDate: addMonths(now, 1),
      tokensUsedThisPeriod: 0,
      pendingPlanKey: '',
      lowBalanceNotified: false,
    },
    { new: true, upsert: true }
  );

  const limit = plan.monthlyTokenLimit;
  console.log(`\n✅ Negocio "${business.name}" → plan ${plan.key.toUpperCase()}` +
    (limit != null ? ` (${limit.toLocaleString('es-MX')} tokens/mes)` : '') + '.');
  console.log(`   Consumo del periodo reiniciado. Renueva: ${sub.renewalDate.toISOString().slice(0, 10)}\n`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('\n❌ Error:', err.message, '\n');
  process.exit(1);
});
