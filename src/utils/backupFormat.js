import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import mongoose from 'mongoose';

/**
 * Formato de respaldo de RenBotIA (.rbk), sin dependencias del servidor para que
 * el script de restauración funcione en cualquier máquina.
 *
 * "RBK1" | salt(16) | iv(12) | tag(16) | AES-256-GCM( gzip(NDJSON) )
 * NDJSON: una línea {"__collection":"nombre"} seguida de sus documentos en EJSON
 * canónico (conserva fechas, ObjectId y demás tipos).
 */

export const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const scrypt = promisify(crypto.scrypt);
const MAGIC = Buffer.from('RBK1');
export const EJSON = () => mongoose.mongo.BSON.EJSON;

async function deriveKey(passphrase, salt) {
  return scrypt(passphrase, salt, 32);
}

export async function encryptBackup(plain, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = await deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), enc]);
}

/** Descifra un .rbk y devuelve el NDJSON (lanza si la frase es incorrecta). */
export async function decryptBackup(buf, passphrase) {
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error('El archivo no es un respaldo de RenBotIA (.rbk).');
  const salt = buf.subarray(4, 20);
  const iv = buf.subarray(20, 32);
  const tag = buf.subarray(32, 48);
  const key = await deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let zipped;
  try {
    zipped = Buffer.concat([decipher.update(buf.subarray(48)), decipher.final()]);
  } catch {
    throw new Error('Frase incorrecta o archivo dañado.');
  }
  return (await gunzip(zipped)).toString('utf8');
}

/** Convierte el NDJSON en { coleccion: [docs] } con los tipos originales. */
export function parseNdjson(ndjson) {
  const out = {};
  let current = null;
  for (const line of ndjson.split('\n')) {
    if (!line) continue;
    const head = line.startsWith('{"__collection":') ? JSON.parse(line) : null;
    if (head && Object.keys(head).length === 1) {
      current = head.__collection;
      out[current] = [];
    } else if (current) {
      out[current].push(EJSON().parse(line, { relaxed: false }));
    }
  }
  return out;
}

