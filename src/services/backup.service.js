import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';
import { sendEmail } from './email.service.js';
import { EJSON, gzip, encryptBackup } from '../utils/backupFormat.js';

/**
 * Respaldo GRATUITO de la base de datos (mientras no haya backups de Atlas).
 *
 * Exporta TODAS las colecciones en EJSON canónico (conserva fechas, ObjectId y
 * demás tipos), comprime con gzip y CIFRA con AES-256-GCM usando una frase
 * secreta (BACKUP_PASSPHRASE). El archivo `.rbk` se manda por correo a
 * BACKUP_EMAIL como adjunto. Sin la frase el archivo es ilegible, así que puede
 * vivir en un correo sin exponer datos de clientes ni tokens.
 *
 * Formato del archivo: ver utils/backupFormat.js.
 * Restaurar: scripts/restore-backup.mjs.
 */

// Resend admite ~40 MB por correo (incluye la codificación base64 del adjunto).
const MAX_ATTACHMENT_BYTES = 28 * 1024 * 1024;

/** Vuelca la base conectada a un NDJSON en memoria. */
async function dumpToNdjson(db) {
  const lines = [];
  const counts = {};
  const collections = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith('system.'))
    .sort();
  for (const name of collections) {
    lines.push(JSON.stringify({ __collection: name }));
    let n = 0;
    for await (const doc of db.collection(name).find({})) {
      lines.push(EJSON().stringify(doc, { relaxed: false }));
      n++;
    }
    counts[name] = n;
  }
  return { ndjson: lines.join('\n'), counts };
}

/** Crea el respaldo cifrado de la base conectada. */
export async function createBackup(passphrase = process.env.BACKUP_PASSPHRASE) {
  if (!passphrase || passphrase.length < 12) {
    throw new Error('Define BACKUP_PASSPHRASE (mínimo 12 caracteres) para cifrar el respaldo.');
  }
  const { ndjson, counts } = await dumpToNdjson(mongoose.connection.db);
  const zipped = await gzip(Buffer.from(ndjson, 'utf8'), { level: 9 });
  const file = await encryptBackup(zipped, passphrase);
  return { file, counts, rawBytes: Buffer.byteLength(ndjson), fileBytes: file.length };
}

const fmtMB = (b) => `${(b / 1024 / 1024).toFixed(2)} MB`;

/** Crea el respaldo y lo manda por correo a BACKUP_EMAIL. */
export async function emailBackup({ reason = 'programado' } = {}) {
  const to = process.env.BACKUP_EMAIL;
  if (!to) throw new Error('Define BACKUP_EMAIL para recibir el respaldo.');
  const started = Date.now();
  const { file, counts, fileBytes } = await createBackup();
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/(\d{8})(\d{4})/, '$1-$2');
  const filename = `renbotia-${stamp}.rbk`;
  const rows = Object.entries(counts)
    .map(([c, n]) => `<tr><td style="padding:2px 12px 2px 0">${c}</td><td style="text-align:right">${n}</td></tr>`)
    .join('');
  const tooBig = fileBytes > MAX_ATTACHMENT_BYTES;

  const res = await sendEmail({
    to,
    subject: `Respaldo RenBotIA ${stamp.slice(0, 8)} (${fmtMB(fileBytes)})`,
    html: `<p>Respaldo ${reason} de la base de datos de RenBotIA.</p>
      <p><strong>Archivo:</strong> ${filename} · ${fmtMB(fileBytes)} (cifrado con tu BACKUP_PASSPHRASE).</p>
      ${tooBig ? '<p style="color:#b91c1c"><strong>El archivo supera el límite de adjuntos del correo y NO se adjuntó.</strong> Es momento de activar los respaldos de Atlas o un almacenamiento externo.</p>' : ''}
      <table style="font:13px monospace">${rows}</table>
      <p style="color:#64748b">Guárdalo en una carpeta segura (Drive, disco externo). Para restaurar: <code>node scripts/restore-backup.mjs ${filename}</code>.</p>`,
    attachments: tooBig ? undefined : [{ filename, content: file.toString('base64') }],
  });
  if (!res?.ok) throw new Error(`No se pudo enviar el correo del respaldo (${res?.status || res?.error || 'sin detalle'}).`);
  logger.info(`Respaldo ${reason}: ${filename} (${fmtMB(fileBytes)}) enviado a ${to} en ${Date.now() - started} ms.`);
  return { filename, fileBytes, counts, attached: !tooBig };
}

/* ── Programador: respaldo cada BACKUP_EVERY_DAYS (7) días ───────────────────
   La fecha del último respaldo se guarda en la base para sobrevivir reinicios y
   despliegues (un setInterval solo se reiniciaría con cada deploy). */

const stateCol = () => mongoose.connection.db.collection('system_state');

async function maybeRunScheduledBackup() {
  const days = Math.max(1, Number(process.env.BACKUP_EVERY_DAYS) || 7);
  const now = Date.now();
  // Reclamo atómico: solo una instancia corre el respaldo de este periodo.
  const claim = await stateCol().findOneAndUpdate(
    { _id: 'backup', $or: [{ lastAt: { $lt: new Date(now - days * 864e5) } }, { lastAt: { $exists: false } }] },
    { $set: { lastAt: new Date(now) } },
    { upsert: false }
  );
  if (!claim) {
    // Primer uso: crea el registro (si ya existía y está al día, no hace nada).
    const created = await stateCol()
      .insertOne({ _id: 'backup', lastAt: new Date(now) })
      .then(() => true)
      .catch(() => false);
    if (!created) return;
  }
  try {
    await emailBackup();
  } catch (err) {
    // Falló: libera el periodo para reintentar en la siguiente revisión.
    await stateCol().updateOne({ _id: 'backup' }, { $set: { lastAt: new Date(0) } });
    logger.warn(`Respaldo programado falló: ${err.message}`);
  }
}

export function startBackupScheduler() {
  if (!process.env.BACKUP_EMAIL || !process.env.BACKUP_PASSPHRASE) {
    logger.info('Respaldo automático: desactivado (falta BACKUP_EMAIL o BACKUP_PASSPHRASE).');
    return;
  }
  const run = () => maybeRunScheduledBackup().catch((err) => logger.warn(`Respaldo: ${err.message}`));
  // Primera revisión a los 2 min del arranque (no compite con el inicio) y luego cada 6 h.
  setTimeout(run, 2 * 60 * 1000).unref?.();
  setInterval(run, 6 * 60 * 60 * 1000).unref?.();
  logger.info(`Respaldo automático: cada ${Math.max(1, Number(process.env.BACKUP_EVERY_DAYS) || 7)} días a ${process.env.BACKUP_EMAIL}.`);
}
