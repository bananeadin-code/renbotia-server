import { Business } from '../models/Business.js';
import { encryptionEnabled, isEncrypted, seal } from '../utils/secretBox.js';
import { logger } from '../utils/logger.js';

const FIELDS = ['facebookPageToken', 'instagramPageToken'];

/**
 * Migración idempotente al arrancar: cifra los tokens de Página que aún estén en
 * claro (guardados antes de configurar DATA_ENCRYPTION_KEY). Lee el valor crudo
 * (lean, sin getters) y escribe con updateOne, sin tocar nada más del negocio.
 */
export async function encryptLegacySecrets() {
  if (!encryptionEnabled()) {
    logger.warn('DATA_ENCRYPTION_KEY no configurada: los tokens de Página se guardan sin cifrar.');
    return { skipped: true };
  }
  const or = FIELDS.map((f) => ({ [f]: { $exists: true, $nin: ['', null], $not: /^enc:v1:/ } }));
  const docs = await Business.find({ $or: or })
    .select(FIELDS.map((f) => `+${f}`).join(' '))
    .lean({ getters: false });
  let updated = 0;
  for (const d of docs) {
    const set = {};
    for (const f of FIELDS) if (d[f] && !isEncrypted(d[f])) set[f] = seal(d[f]);
    if (Object.keys(set).length) {
      await Business.collection.updateOne({ _id: d._id }, { $set: set });
      updated += 1;
    }
  }
  if (updated) logger.info(`Cifrado de tokens: ${updated} negocio(s) migrados.`);
  return { updated };
}
