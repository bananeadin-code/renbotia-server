// Prueba manual (solo local) del asistente del dueño con la IA real.
// Uso: MONGODB_URI=mongodb://127.0.0.1:27019/rb_e2e node scripts/tryOwnerAssistant.mjs
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';

if (!/127\.0\.0\.1|localhost/.test(env.mongoUri || process.env.MONGODB_URI || '')) {
  console.error('Solo contra una base local.');
  process.exit(1);
}
await mongoose.connect(process.env.MONGODB_URI);
const { Business } = await import('../src/models/Business.js');
const svc = await import('../src/services/ownerControl.service.js');

const WA = '5210000000001';
const business = await Business.findOne({ name: 'Cafe Prueba' });
await Business.updateOne(
  { _id: business._id },
  {
    $set: {
      ownerWhatsApp: [{ waId: WA, linkedAt: new Date(), lastUsedAt: new Date() }],
      ownerUsage: { day: '', count: 0 },
      'ownerPending.action': '',
      'channelSettings.whatsapp.paused': true,
      'channelSettings.whatsapp.pausedUntil': new Date(Date.now() + 6 * 3600e3),
      'channelSettings.facebook.paused': true,
      'channelSettings.facebook.pausedUntil': new Date(Date.now() + 6 * 3600e3),
      'channelSettings.instagram.paused': true,
      'channelSettings.instagram.pausedUntil': new Date(Date.now() + 6 * 3600e3),
    },
  }
);
svc.__setOwnerTestHooks({ send: async ({ text }) => console.log(`\n  BOT: ${text.replace(/\n/g, '\n       ')}`) });

const turns = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'Cancela pausar el bot porque fue una prueba de tu funcionamiento',
      'En todos',
      'El bot en modo cliente está pausado?',
      'pausa solo instagram una hora',
      'sí',
      '¿qué quería Laura?',
    ];
for (const t of turns) {
  console.log(`\nDUEÑO: ${t}`);
  await svc.handleOwnerMessage({ business: await Business.findById(business._id), waId: WA, msg: { type: 'text', text: { body: t } } });
}
const cs = (await Business.findById(business._id).lean()).channelSettings;
console.log('\nEstado final:', { whatsapp: cs.whatsapp.paused, messenger: cs.facebook.paused, instagram: cs.instagram.paused });
await mongoose.disconnect();
