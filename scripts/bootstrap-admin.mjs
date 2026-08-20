/**
 * Arranque de producción (base de datos nueva).
 *
 * Hace dos cosas, de forma segura y repetible (idempotente):
 *   1) Siembra los PLANES (Free/Pro/Elite) si no existen. Sin ellos, el
 *      onboarding y la facturación no funcionan.
 *   2) Crea o promueve a un usuario como ADMIN, con la contraseña que le pases.
 *
 * NO borra nada ni crea cuentas demo. Puedes correrlo las veces que quieras.
 *
 * Uso:
 *   node scripts/bootstrap-admin.mjs "tucorreo@ejemplo.com" "TuContraseñaSegura" "Tu Nombre"
 *
 * Toma la conexión de MONGODB_URI (la misma variable que usa el servidor),
 * así que en el Shell de Render ya apunta a tu base de Atlas.
 */
import mongoose from 'mongoose';
import { PLANS } from '../src/config/constants.js';
import { ROLES } from '../src/config/constants.js';
import { Plan } from '../src/models/Plan.js';
import { User } from '../src/models/User.js';

const [, , emailArg, passwordArg, nameArg] = process.argv;
const MONGODB_URI = process.env.MONGODB_URI;

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

if (!MONGODB_URI) fail('Falta MONGODB_URI en el entorno.');
if (!emailArg || !passwordArg) {
  fail(
    'Uso: node scripts/bootstrap-admin.mjs "correo@ejemplo.com" "ContraseñaSegura" "Nombre (opcional)"'
  );
}
if (passwordArg.length < 8) fail('La contraseña debe tener al menos 8 caracteres.');

const email = emailArg.trim().toLowerCase();
const name = (nameArg || 'Admin').trim();

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log('✓ Conectado a la base de datos.');

  // 1) Planes (upsert por `key`): crea el que falte, no duplica.
  for (const plan of PLANS) {
    await Plan.updateOne({ key: plan.key }, { $setOnInsert: plan }, { upsert: true });
  }
  const planKeys = (await Plan.find().select('key')).map((p) => p.key).join(', ');
  console.log(`✓ Planes en la base: ${planKeys}`);

  // 2) Admin: si ya existe el correo, lo promueve; si no, lo crea.
  let user = await User.findOne({ email });
  if (user) {
    user.role = ROLES.ADMIN;
    await user.setPassword(passwordArg);
    if (nameArg) user.name = name;
    await user.save();
    console.log(`✓ Usuario existente promovido a ADMIN y contraseña actualizada: ${email}`);
  } else {
    user = new User({ name, email, role: ROLES.ADMIN });
    await user.setPassword(passwordArg);
    await user.save();
    console.log(`✓ Admin creado: ${email}`);
  }

  await mongoose.disconnect();
  console.log('\n✅ Listo. Ya puedes iniciar sesión como administrador.\n');
}

main().catch((err) => {
  console.error('\n❌ Error:', err.message, '\n');
  process.exit(1);
});
