/**
 * Limpia negocios/proyectos DUPLICADOS de un mismo dueño.
 *
 * Conserva el negocio MÁS ANTIGUO del usuario y elimina los demás, junto con
 * TODO lo que cuelga de ellos (config del bot, suscripción, chats, leads,
 * pagos, membresías, etc.). Aislado por el campo `business` en cada colección.
 *
 * Seguro por diseño:
 *   - Modo simulación por defecto: SOLO muestra qué borraría, no toca nada.
 *   - Borra de verdad únicamente si agregas la bandera --confirm.
 *   - Nunca toca el negocio más antiguo ni datos de otros usuarios.
 *
 * Uso (en el Shell de Render):
 *   node scripts/cleanup-duplicate-projects.mjs "tucorreo@ejemplo.com"            # simulación
 *   node scripts/cleanup-duplicate-projects.mjs "tucorreo@ejemplo.com" --confirm  # borra
 */
import mongoose from 'mongoose';
import { User } from '../src/models/User.js';
import { Business } from '../src/models/Business.js';
import { BotConfig } from '../src/models/BotConfig.js';
import { Subscription } from '../src/models/Subscription.js';
import { ChatSimulation } from '../src/models/ChatSimulation.js';
import { ManagedRecord } from '../src/models/ManagedRecord.js';
import { ManagementConfig } from '../src/models/ManagementConfig.js';
import { BillingProfile } from '../src/models/BillingProfile.js';
import { Membership } from '../src/models/Membership.js';
import { Invitation } from '../src/models/Invitation.js';
import { PhoneVerification } from '../src/models/PhoneVerification.js';
import { Payment } from '../src/models/Payment.js';
import { UsageLog } from '../src/models/UsageLog.js';
import { AuditLog } from '../src/models/AuditLog.js';

// Todas las colecciones que referencian a un Business por el campo `business`.
const RELATED = [
  ['BotConfig', BotConfig],
  ['Subscription', Subscription],
  ['ChatSimulation', ChatSimulation],
  ['ManagedRecord', ManagedRecord],
  ['ManagementConfig', ManagementConfig],
  ['BillingProfile', BillingProfile],
  ['Membership', Membership],
  ['Invitation', Invitation],
  ['PhoneVerification', PhoneVerification],
  ['Payment', Payment],
  ['UsageLog', UsageLog],
  ['AuditLog', AuditLog],
];

const [, , emailArg, ...flags] = process.argv;
const CONFIRM = flags.includes('--confirm');
const MONGODB_URI = process.env.MONGODB_URI;

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

if (!MONGODB_URI) fail('Falta MONGODB_URI en el entorno.');
if (!emailArg) fail('Uso: node scripts/cleanup-duplicate-projects.mjs "correo@ejemplo.com" [--confirm]');

const email = emailArg.trim().toLowerCase();

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log(`✓ Conectado. Modo: ${CONFIRM ? 'BORRADO REAL' : 'SIMULACIÓN (no borra nada)'}\n`);

  const user = await User.findOne({ email }).select('_id name email');
  if (!user) fail(`No existe un usuario con el correo ${email}.`);

  // Negocios del dueño, del más antiguo al más nuevo.
  const businesses = await Business.find({ owner: user._id }).sort({ createdAt: 1 }).select('_id name createdAt');
  if (businesses.length <= 1) {
    console.log(`Este usuario tiene ${businesses.length} negocio(s). No hay duplicados que limpiar.\n`);
    await mongoose.disconnect();
    return;
  }

  const keep = businesses[0];
  const toDelete = businesses.slice(1);
  console.log(`Dueño: ${user.name} <${user.email}>`);
  console.log(`CONSERVA (más antiguo): ${keep.name} — ${keep._id} (${keep.createdAt.toISOString()})`);
  console.log(`ELIMINA (${toDelete.length}):`);
  toDelete.forEach((b) => console.log(`  · ${b.name} — ${b._id} (${b.createdAt.toISOString()})`));
  console.log('');

  const ids = toDelete.map((b) => b._id);

  for (const [label, Model] of RELATED) {
    const filter = { business: { $in: ids } };
    if (CONFIRM) {
      const { deletedCount } = await Model.deleteMany(filter);
      console.log(`  ${label}: ${deletedCount} borrado(s)`);
    } else {
      const count = await Model.countDocuments(filter);
      console.log(`  ${label}: ${count} se borraría(n)`);
    }
  }

  if (CONFIRM) {
    const { deletedCount } = await Business.deleteMany({ _id: { $in: ids } });
    console.log(`  Business: ${deletedCount} borrado(s)`);
    console.log('\n✅ Limpieza completa. Quedó 1 negocio.\n');
  } else {
    console.log(`  Business: ${ids.length} se borraría(n)`);
    console.log('\nℹ️  Simulación. Para borrar de verdad, repite con  --confirm\n');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('\n❌ Error:', err.message, '\n');
  process.exit(1);
});
