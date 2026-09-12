/**
 * Crea (o actualiza) una cuenta de PRUEBA para el revisor de Meta (App Review),
 * con plan Free y un negocio sencillo ya configurado y listo para la demo.
 *
 * Idempotente: puedes correrlo varias veces; no duplica el negocio.
 *
 * Puntos clave para el revisor:
 *   - emailVerified: true  → no necesita confirmar correo.
 *   - twoFactorEnabled: false → entra SOLO con correo + contraseña (no recibe
 *     nuestros códigos por correo, así que el 2FA debe estar apagado).
 *   - rol 'cliente' (una cuenta normal, no admin).
 *
 * Uso (en el Shell de Render, donde ya está MONGODB_URI):
 *   node scripts/seed-reviewer.mjs "reviewer@renbotia.com" "ContraseñaSegura123"
 *
 * Toma la conexión de MONGODB_URI (la misma que usa el servidor).
 */
import mongoose from 'mongoose';
import { PLANS, ROLES } from '../src/config/constants.js';
import { Plan } from '../src/models/Plan.js';
import { User } from '../src/models/User.js';
import { provisionBusiness } from '../src/services/business.service.js';

const [, , emailArg, passwordArg] = process.argv;
const MONGODB_URI = process.env.MONGODB_URI;

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

if (!MONGODB_URI) fail('Falta MONGODB_URI en el entorno.');
if (!emailArg || !passwordArg) {
  fail('Uso: node scripts/seed-reviewer.mjs "reviewer@renbotia.com" "ContraseñaSegura123"');
}
if (passwordArg.length < 8) fail('La contraseña debe tener al menos 8 caracteres.');

const email = emailArg.trim().toLowerCase();

// Negocio demo sencillo (despacho legal) con 2 FAQs (tope de Free) y datos base.
const DEMO_BUSINESS = { name: 'Despacho Jurídico Demo', industry: 'legal' };
const DEMO_BOTCONFIG = {
  botName: 'Asistente Legal',
  tone: 'neutral', // Free usa tono neutral
  faqs: [
    { question: '¿Cuál es su horario de atención?', answer: 'Atendemos de lunes a viernes, de 9:00 a 18:00 h.' },
    { question: '¿Dónde están ubicados?', answer: 'Estamos en el centro de Durango, Durango, México.' },
  ],
  businessInfo: {
    hours: 'Lunes a viernes de 9:00 a 18:00 h',
    location: 'Centro de Durango, Durango, México',
    services: ['Consulta legal inicial', 'Contratos', 'Trámites'],
    basePricing: 'Consulta inicial desde $500 MXN.',
  },
};

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log('✓ Conectado a la base de datos.');

  // 1) Planes (upsert por key): asegura que Free exista.
  for (const plan of PLANS) {
    await Plan.updateOne({ key: plan.key }, { $setOnInsert: plan }, { upsert: true });
  }

  // 2) Usuario revisor: crea o actualiza contraseña y ajustes de acceso.
  let user = await User.findOne({ email });
  if (user) {
    user.role = ROLES.CLIENTE;
    user.emailVerified = true;
    user.twoFactorEnabled = false;
    await user.setPassword(passwordArg);
    await user.save();
    console.log(`✓ Usuario existente actualizado: ${email}`);
  } else {
    user = new User({
      name: 'Meta Reviewer',
      email,
      role: ROLES.CLIENTE,
      emailVerified: true,
      twoFactorEnabled: false,
    });
    await user.setPassword(passwordArg);
    await user.save();
    console.log(`✓ Usuario revisor creado: ${email}`);
  }

  // 3) Negocio Free + BotConfig (idempotente: si ya tiene negocio, lo reutiliza).
  const bundle = await provisionBusiness({
    owner: user._id,
    planKey: 'free',
    business: DEMO_BUSINESS,
    botConfig: DEMO_BOTCONFIG,
  });
  console.log(`✓ Negocio listo: "${bundle.business.name}" (plan ${bundle.subscription.plan.key}).`);

  await mongoose.disconnect();
  console.log('\n✅ Cuenta de revisor lista. Inicia sesión con el correo y la contraseña indicados.\n');
}

main().catch((err) => {
  console.error('\n❌ Error:', err.message, '\n');
  process.exit(1);
});
