/**
 * Sincroniza los PLANES de la base de datos con los definidos en el código
 * (constants.PLANS): nombre, precio, límite de tokens y beneficios (highlights).
 *
 * Úsalo cuando cambies precios o los beneficios de un plan y quieras reflejarlos
 * en producción SIN re-sembrar todo (no toca usuarios, negocios ni suscripciones).
 *
 * Uso:  node scripts/sync-plans.mjs
 * Toma MONGODB_URI del entorno (Shell de Render, o local apuntando a Atlas).
 */
import mongoose from 'mongoose';
import { PLANS } from '../src/config/constants.js';
import { Plan } from '../src/models/Plan.js';

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('\n❌ Falta MONGODB_URI en el entorno.\n');
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  for (const p of PLANS) {
    await Plan.updateOne(
      { key: p.key },
      {
        $set: {
          name: p.name,
          priceMXN: p.priceMXN,
          monthlyTokenLimit: p.monthlyTokenLimit,
          highlights: p.highlights,
          isActive: true,
        },
      },
      { upsert: true }
    );
    console.log(`✓ ${p.key}: ${p.highlights.length} beneficios, $${p.priceMXN} MXN`);
  }
  console.log('\n✅ Planes sincronizados.\n');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('\n❌ Error:', err.message, '\n');
  process.exit(1);
});
