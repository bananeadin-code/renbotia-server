import { z } from 'zod';
import { ApiError } from './ApiError.js';
import { isPdf, pdfPageCount, safeFileName, MAX_DOC_BYTES } from './document.js';

/**
 * Archivo subido desde el navegador (chat del sitio o simulador): foto o PDF en
 * base64 sin prefijo. Mismas reglas en ambos lados.
 */

const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // límite práctico de la visión de la IA
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export const inboundFileSchema = z.object({
  kind: z.enum(['image', 'pdf']),
  mediaType: z.string().max(60),
  // ~5 MB en base64; el tamaño real se valida al decodificar.
  data: z.string().max(7_000_000).regex(/^[A-Za-z0-9+/=]+$/, 'Archivo no válido'),
  name: z.string().max(200).optional().default(''),
});

// Firma real del archivo (no basta con el tipo que declara el navegador).
function imageMagicOk(buf, mime) {
  const hex = buf.subarray(0, 12).toString('hex');
  if (mime === 'image/jpeg') return hex.startsWith('ffd8ff');
  if (mime === 'image/png') return hex.startsWith('89504e470d0a1a0a');
  if (mime === 'image/gif') return hex.startsWith('47494638');
  if (mime === 'image/webp') return hex.startsWith('52494646') && buf.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}

/**
 * Valida el archivo y lo convierte al formato de processMessage.
 * @returns {{ image?: object, document?: object }}
 */
export function parseUploadedFile(file) {
  if (!file) return {};
  const buf = Buffer.from(file.data, 'base64');
  if (file.kind === 'image') {
    if (!IMAGE_MIMES.includes(file.mediaType) || !imageMagicOk(buf, file.mediaType)) {
      throw ApiError.badRequest('La imagen no es válida (usa JPG, PNG, WEBP o GIF).');
    }
    if (buf.length > MAX_IMAGE_BYTES) throw ApiError.badRequest('La imagen pesa demasiado (máximo 4 MB).');
    return { image: { mediaType: file.mediaType, data: file.data } };
  }
  if (!isPdf(buf)) throw ApiError.badRequest('Solo se aceptan documentos PDF.');
  if (buf.length > MAX_DOC_BYTES) throw ApiError.badRequest('El PDF pesa demasiado (máximo 5 MB).');
  return {
    document: { mediaType: 'application/pdf', data: file.data, name: safeFileName(file.name), pages: pdfPageCount(buf) },
  };
}
