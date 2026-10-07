import crypto from 'node:crypto';
import { logger } from './logger.js';

/**
 * Cifrado en reposo de secretos guardados en Mongo (tokens de Página de
 * Facebook/Instagram). AES-256-GCM con la llave DATA_ENCRYPTION_KEY (32 bytes
 * en base64 o hex). Formato: "enc:v1:<iv>:<tag>:<texto cifrado>" (base64url).
 *
 * - Sin llave configurada: se guarda tal cual (compatibilidad) y se avisa.
 * - Lectura tolerante: un valor sin prefijo se devuelve como está (datos viejos).
 * - Si la llave cambia o el dato está dañado, devuelve '' (el canal aparece
 *   desconectado y se reconecta) en vez de tumbar el proceso.
 *
 * Si se pierde la llave, basta con reconectar las Páginas: no hay pérdida de
 * datos del negocio.
 */

const PREFIX = 'enc:v1:';
let cachedKey;

function key() {
  if (cachedKey !== undefined) return cachedKey;
  const raw = String(process.env.DATA_ENCRYPTION_KEY || '').trim();
  if (!raw) {
    cachedKey = null;
    return null;
  }
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    logger.error('DATA_ENCRYPTION_KEY inválida: debe tener 32 bytes (base64 o 64 caracteres hex). Se ignora.');
    cachedKey = null;
    return null;
  }
  cachedKey = buf;
  return buf;
}

export const encryptionEnabled = () => Boolean(key());
export const isEncrypted = (v) => typeof v === 'string' && v.startsWith(PREFIX);

/** Cifra un texto (idempotente: si ya viene cifrado o vacío, lo deja igual). */
export function seal(value) {
  if (!value || typeof value !== 'string' || isEncrypted(value)) return value;
  const k = key();
  if (!k) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${ct.toString('base64url')}`;
}

/** Descifra; valores sin prefijo se devuelven tal cual. */
export function open(value) {
  if (!isEncrypted(value)) return value;
  const k = key();
  if (!k) {
    logger.error('Hay secretos cifrados pero falta DATA_ENCRYPTION_KEY.');
    return '';
  }
  try {
    const [ivB, tagB, ctB] = value.slice(PREFIX.length).split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(ivB, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    logger.error('No se pudo descifrar un secreto (¿cambió DATA_ENCRYPTION_KEY?).');
    return '';
  }
}

/** Para pruebas: olvida la llave leída (relee el entorno). */
export function _resetKeyCache() {
  cachedKey = undefined;
}
