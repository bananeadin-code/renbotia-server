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
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => esc(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(c.get(r))).join(',')).join('\n');
  return `﻿${head}\n${body}`;
}
