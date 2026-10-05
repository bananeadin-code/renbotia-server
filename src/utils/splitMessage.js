/**
 * Parte un texto largo en trozos que respeten el límite de caracteres de un canal
 * (Messenger 2000, Instagram 1000), cortando de preferencia entre párrafos, luego
 * entre oraciones y al final entre palabras, para que cada mensaje se lea natural.
 * @param {string} text
 * @param {number} max
 * @returns {string[]}
 */
export function splitMessage(text, max) {
  const clean = String(text || '').trim();
  if (clean.length <= max) return clean ? [clean] : [];
  const parts = [];
  let rest = clean;
  while (rest.length > max) {
    const slice = rest.slice(0, max);
    let cut = slice.lastIndexOf('\n\n');
    if (cut < max * 0.4) cut = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('? '), slice.lastIndexOf('! ')) + 1;
    if (cut < max * 0.4) cut = slice.lastIndexOf(' ');
    if (cut < max * 0.4) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
