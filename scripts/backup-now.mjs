/**
 * Respaldo inmediato de la base de datos, cifrado y enviado por correo.
 *
 * Uso (Shell de Render):  node scripts/backup-now.mjs
 * Opcional:               node scripts/backup-now.mjs --file respaldo.rbk   (guarda en disco, sin correo)
 *
 * Requiere MONGODB_URI, BACKUP_PASSPHRASE (mín. 12 caracteres) y, para el correo,
 * BACKUP_EMAIL + RESEND_API_KEY. El archivo .rbk solo se abre con la frase:
 * guárdala en tu gestor de contraseñas; sin ella el respaldo no sirve.
 */
import fs from 'node:fs/promises';
import mongoose from 'mongoose';
import { createBackup, emailBackup } from '../src/services/backup.service.js';

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('\n❌ Falta MONGODB_URI en el entorno.\n');
  process.exit(1);
}
const fileArg = process.argv.indexOf('--file');

try {
  await mongoose.connect(MONGODB_URI);
  if (fileArg > -1) {
    const out = process.argv[fileArg + 1] || `renbotia-${Date.now()}.rbk`;
    const { file, counts } = await createBackup();
    await fs.writeFile(out, file);
    console.log(`\n✅ Respaldo guardado en ${out} (${(file.length / 1024 / 1024).toFixed(2)} MB)`);
    console.table(counts);
  } else {
    const r = await emailBackup({ reason: 'manual' });
    console.log(`\n✅ Respaldo ${r.filename} enviado a ${process.env.BACKUP_EMAIL}${r.attached ? '' : ' (SIN adjunto: demasiado grande)'}`);
    console.table(r.counts);
  }
} catch (err) {
  console.error(`\n❌ ${err.message}\n`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
