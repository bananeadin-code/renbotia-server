/**
 * Genera un CSV a partir de filas y una definición de columnas.
 * Antepone un BOM (﻿) para que Excel abra bien los acentos (UTF-8).
 *
 * @param {object[]} rows
 * @param {{ label: string, get: (row:object)=>any }[]} columns
 * @returns {string}
 */
export function toCsv(rows, columns) {
  const esc = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    // Inyección de fórmulas: un cliente podría escribir "=HYPERLINK(...)" en el
    // chat y Excel lo ejecutaría al abrir el archivo. Un apóstrofo lo vuelve texto.
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => esc(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(c.get(r))).join(',')).join('\n');
  return `﻿${head}\n${body}`;
}
