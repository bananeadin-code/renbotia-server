/**
 * La IA tiende a responder en markdown (**negritas**, ## títulos, [texto](url)).
 * Ningún canal de chat lo muestra así: WhatsApp usa *un* asterisco para negrita y
 * Messenger, Instagram y el chat web enseñan el texto tal cual. Esto adapta la
 * respuesta al formato que entiende cada canal antes de enviarla y guardarla.
 *
 * - whatsapp / simulator (imita WhatsApp): **x** → *x*, títulos → *título*.
 * - resto (web, facebook, instagram, site): texto plano, sin asteriscos.
 */
const WHATSAPP_STYLE = new Set(['whatsapp', 'simulator']);

export function formatForChannel(text, channel) {
  if (!text) return text;
  const wa = WHATSAPP_STYLE.has(channel);
  let t = String(text);

  // [texto](https://…) → "texto: https://…" (o solo la URL si es la misma).
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => (label.trim() === url ? url : `${label.trim()}: ${url}`));
  // Títulos "## Algo" → línea resaltada (WhatsApp) o simple.
  t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, (_, h) => (wa ? `*${h}*` : h));
  // Negritas dobles.
  t = t.replace(/\*\*(?=\S)([^*\n]+?)\*\*/g, wa ? '*$1*' : '$1');
  t = t.replace(/__(?=\S)([^_\n]+?)__/g, wa ? '_$1_' : '$1');
  // Separadores horizontales.
  t = t.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '');
  // Viñetas "* algo" → "- algo" (un asterisco suelto confunde en cualquier canal).
  t = t.replace(/^([ \t]*)\*[ \t]+/gm, '$1- ');
  // Fuera de WhatsApp tampoco sirve *énfasis* sencillo.
  if (!wa) t = t.replace(/(^|[\s(¡¿"])\*(?=\S)([^*\n]+?)\*(?=$|[\s.,;:!?)"])/gm, '$1$2');
  // Bloques de código ``` → texto.
  t = t.replace(/```[a-z]*\n?/gi, '');
  return t.replace(/\n{3,}/g, '\n\n').trim();
}
