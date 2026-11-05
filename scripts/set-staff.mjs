/**
 * Roles del equipo comercial de RenBotIA y de la agencia de marketing.
 *
 * "soporte": ve el Embudo (seguimiento de registros, notas, asignaciones). No ve
 * montos, inversión ni el resto del panel de admin.
 * "agencia": ve Campañas (resultados de Meta y Google por campaña, sin datos de
 * personas), captura su inversión en pauta y descarga conversiones para Google Ads.
 * La persona debe crear antes su cuenta normal en renbotia.com.
 *
 * Uso (Shell de Render, con MONGODB_URI en el entorno):
 *   node scripts/set-staff.mjs "correo@ejemplo.com" soporte   → le da el rol
 *   node scripts/set-staff.mjs "correo@agencia.com" agencia   → acceso de la agencia
 *   node scripts/set-staff.mjs "correo@ejemplo.com" cliente   → se lo quita
 */
import mongoose from 'mongoose';
import { User } from '../src/models/User.js';

const [, , emailArg, roleArg] = process.argv;

function fail(msg) {
  console.error(`\nERROR: ${msg}\n`);
  process.exit(1);
}

if (!process.env.MONGODB_URI) fail('Falta MONGODB_URI en el entorno.');
const role = String(roleArg || '').trim().toLowerCase();
if (!emailArg || !['soporte', 'agencia', 'cliente'].includes(role)) fail('Uso: node scripts/set-staff.mjs "correo@ejemplo.com" soporte|agencia|cliente');

await mongoose.connect(process.env.MONGODB_URI);
const user = await User.findOne({ email: emailArg.trim().toLowerCase() });
if (!user) fail(`No existe un usuario con el correo ${emailArg}. Pídele que cree su cuenta primero.`);
if (user.role === 'admin') fail('Esa cuenta es administradora; no se cambia desde aquí.');
user.role = role;
// Cambiar el rol cierra sus sesiones para que entre de nuevo con los permisos nuevos.
user.tokenVersion = (user.tokenVersion || 0) + 1;
await user.save();
console.log(`\nListo: ${user.email} ahora tiene el rol "${role}". Debe volver a iniciar sesión.\n`);
await mongoose.disconnect();
