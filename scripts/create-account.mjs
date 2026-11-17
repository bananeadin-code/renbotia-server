/**
 * Crea una cuenta normal (rol cliente) YA VERIFICADA, sin pasar por el código de
 * confirmación de correo. Pensado para cuentas de prueba o de la agencia
 * (Dinametra) que necesitan entrar sin esperar el correo.
 *
 * - No crea negocio: al entrar, la persona pasa por el onboarding normal.
 * - No dispara eventos de conversión (Meta CAPI / funnel), así que NO ensucia la
 *   medición de campañas.
 * - Si el correo ya existe, NO lo toca (para no cambiar la contraseña de un
 *   cliente real por accidente).
 *
 * Uso (en el Shell de Render, donde ya está MONGODB_URI):
 *   node scripts/create-account.mjs "Nombre Apellido" "correo@dominio.com" "ContraseñaSegura123"
 *
 * Opcional: --sin-2fa  → la cuenta entra solo con correo + contraseña (sin código
 * por correo al iniciar sesión). Úsalo SOLO si el correo no es real o no recibe
 * correos; con un correo real, deja el 2FA encendido.
 */
import mongoose from 'mongoose';
import { ROLES } from '../src/config/constants.js';
import { User } from '../src/models/User.js';

const args = process.argv.slice(2);
const sin2fa = args.includes('--sin-2fa');
const [nameArg, emailArg, passwordArg] = args.filter((a) => a !== '--sin-2fa');
const MONGODB_URI = process.env.MONGODB_URI;

function fail(msg) {
  console.error(`\nError: ${msg}\n`);
  process.exit(1);
}

if (!MONGODB_URI) fail('Falta MONGODB_URI en el entorno.');
if (!nameArg || !emailArg || !passwordArg) {
  fail('Uso: node scripts/create-account.mjs "Nombre" "correo@dominio.com" "Contraseña" [--sin-2fa]');
}
const name = nameArg.trim();
const email = emailArg.trim().toLowerCase();
if (name.length < 2 || name.length > 80) fail('El nombre debe tener entre 2 y 80 caracteres.');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('El correo no tiene un formato válido.');
if (passwordArg.length < 8) fail('La contraseña debe tener al menos 8 caracteres.');

async function main() {
  await mongoose.connect(MONGODB_URI);

  if (await User.exists({ email })) {
    await mongoose.disconnect();
    fail(`Ya existe una cuenta con ${email}. No se modificó nada.`);
  }

  const user = new User({
    name,
    email,
    role: ROLES.CLIENTE,
    emailVerified: true,
    twoFactorEnabled: !sin2fa,
  });
  await user.setPassword(passwordArg);
  await user.save();

  await mongoose.disconnect();
  console.log(`\nCuenta creada: ${name} <${email}>`);
  console.log(`  Correo verificado: sí · 2FA por correo al iniciar sesión: ${sin2fa ? 'no' : 'sí'}`);
  console.log('  Al entrar, completará el onboarding para crear su negocio.\n');
}

main().catch(async (err) => {
  console.error('\nError:', err.message, '\n');
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
