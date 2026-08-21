/**
 * Conecta un negocio a su número de WhatsApp en Meta (Cloud API).
 *
 * Guarda el phone_number_id (y opcionalmente el WABA id) en el negocio del dueño
 * indicado. Con eso, el webhook enruta los mensajes entrantes de ese número al
 * negocio correcto y el bot responde.
 *
 * Uso:
 *   node scripts/connect-whatsapp.mjs "correo-del-dueño@ejemplo.com" "<PHONE_NUMBER_ID>" ["<WABA_ID>"]
 *
 * Dónde sacar el PHONE_NUMBER_ID: Meta → WhatsApp → API Setup, en la tarjeta del
 * número aparece "Phone number ID". Toma MONGODB_URI del entorno (Shell de Render
 * o local apuntando a Atlas).
 */
import mongoose from 'mongoose';
import { User } from '../src/models/User.js';
import { Business } from '../src/models/Business.js';

const [, , emailArg, phoneNumberId, wabaId] = process.argv;
const MONGODB_URI = process.env.MONGODB_URI;

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

if (!MONGODB_URI) fail('Falta MONGODB_URI en el entorno.');
if (!emailArg || !phoneNumberId) {
  fail('Uso: node scripts/connect-whatsapp.mjs "correo@ejemplo.com" "<PHONE_NUMBER_ID>" ["<WABA_ID>"]');
}

async function main() {
  await mongoose.connect(MONGODB_URI);

  const user = await User.findOne({ email: emailArg.trim().toLowerCase() });
  if (!user) fail(`No existe un usuario con el correo ${emailArg}.`);

  const business = await Business.findOne({ owner: user._id });
  if (!business) fail(`El usuario ${emailArg} no tiene un negocio.`);

  // Evita conectar el mismo número a dos negocios distintos.
  const clash = await Business.findOne({
    whatsappPhoneNumberId: phoneNumberId,
    _id: { $ne: business._id },
  });
  if (clash) fail(`Ese phone_number_id ya está conectado a otro negocio (${clash.name}).`);

  business.whatsappPhoneNumberId = phoneNumberId;
  if (wabaId) business.whatsappWabaId = wabaId;
  await business.save();

  console.log(`\n✅ Negocio "${business.name}" conectado a WhatsApp.`);
  console.log(`   phone_number_id: ${phoneNumberId}${wabaId ? `\n   waba_id: ${wabaId}` : ''}\n`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('\n❌ Error:', err.message, '\n');
  process.exit(1);
});
