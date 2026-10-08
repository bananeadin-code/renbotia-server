/**
 * Utilidades para documentos que envían los clientes (PDF).
 */

export const MAX_DOC_BYTES = 5 * 1024 * 1024; // 5 MB
// Tope de páginas que se le pasan a la IA: cada página cuesta tokens (texto +
// imagen de la página). Un PDF más largo se guarda para el equipo, pero el bot
// pide que le indiquen qué parte revisar.
export const MAX_DOC_PAGES = 20;

/** ¿Los bytes son realmente un PDF? (firma %PDF-, no solo el mime declarado) */
export function isPdf(buf) {
  return Buffer.isBuffer(buf) && buf.length > 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

/**
 * Número de páginas APROXIMADO (cuenta objetos /Type /Page). Suficiente para
 * decidir si es razonable pasarlo a la IA; no es un parser de PDF.
 */
export function pdfPageCount(buf) {
  const s = buf.toString('latin1');
  const m = s.match(/\/Type\s*\/Page(?!s)\b/g);
  return m ? m.length : 0;
}

/** Nombre de archivo seguro para mostrar/descargar. */
export function safeFileName(name, fallback = 'documento.pdf') {
  const clean = String(name || '')
    .replace(/[\/:*?"<>|\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 120);
  return clean || fallback;
}
