/**
 * Abre un respaldo .rbk de RenBotIA (creado por backup-now.mjs o el respaldo
 * automático por correo).
 *
 * 1) Ver qué contiene (no toca ninguna base):
 *      BACKUP_PASSPHRASE="tu frase" node scripts/restore-backup.mjs renbotia-20261005-0300.rbk
 *
 * 2) Restaurarlo en una base de datos:
 *      BACKUP_PASSPHRASE="tu frase" node scripts/restore-backup.mjs archivo.rbk --uri "mongodb+srv://..." --confirm
 *    Por seguridad se niega si alguna colección destino ya tiene datos. Para
 *    reemplazarlas añade --drop (BORRA lo que haya en esas colecciones).
 *
 * Recomendado: restaurar primero en una base NUEVA, revisar, y luego apuntar el
 * servidor a ella.
 */
import fs from 'node:fs/promises';
import mongoose from 'mongoose';
import { decryptBackup, parseNdjson } from '../src/utils/backupFormat.js';

const [, , file, ...rest] = process.argv;
const flag = (f) => rest.includes(f);
const uriIdx = rest.indexOf('--uri');
const uri = uriIdx > -1 ? rest[uriIdx + 1] : '';
const pass = process.env.BACKUP_PASSPHRASE;

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}
if (!file) fail('Indica el archivo .rbk. Ej: node scripts/restore-backup.mjs renbotia-20261005-0300.rbk');
if (!pass) fail('Define BACKUP_PASSPHRASE con la frase con la que se creó el respaldo.');

let data;
try {
  data = parseNdjson(await decryptBackup(await fs.readFile(file), pass));
} catch (err) {
  fail(err.message);
}
console.log('\nContenido del respaldo:');
console.table(Object.fromEntries(Object.entries(data).map(([c, docs]) => [c, docs.length])));

if (!uri) {
  console.log('\nSolo lectura. Para restaurar añade --uri "<mongodb>" --confirm\n');
  process.exit(0);
}
if (!flag('--confirm')) fail('Añade --confirm para escribir en la base indicada.');

await mongoose.connect(uri);
const db = mongoose.connection.db;
try {
  for (const [name, docs] of Object.entries(data)) {
    const col = db.collection(name);
    const existing = await col.estimatedDocumentCount();
    if (existing && !flag('--drop')) fail(`La colección "${name}" ya tiene ${existing} documentos. Usa una base vacía o añade --drop.`);
    if (existing) await col.deleteMany({});
    if (docs.length) await col.insertMany(docs, { ordered: false });
    console.log(`✔ ${name}: ${docs.length}`);
  }
  console.log('\n✅ Restauración completa. Al arrancar, el servidor recrea los índices.\n');
} finally {
  await mongoose.disconnect();
}
