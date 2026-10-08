/**
 * Plantillas de WhatsApp: lectura de su estructura y llenado de variables.
 *
 * Meta tiene dos formatos de variables en el cuerpo:
 *  - POSICIONAL: {{1}}, {{2}}… (se mandan en orden).
 *  - CON NOMBRE: {{nombre}}, {{pedido}}… (se mandan con parameter_name).
 */

const VAR_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** Variables del texto en orden de aparición, sin repetir. */
export function templateVars(text = '') {
  const seen = [];
  for (const m of String(text).matchAll(VAR_RE)) if (!seen.includes(m[1])) seen.push(m[1]);
  return seen;
}

/**
 * Resume una plantilla de la Graph API para el panel: cuerpo, variables y si el
 * sistema puede enviarla sola (sin encabezado multimedia ni con variables, ni
 * botones de URL dinámica, que exigirían datos que no tenemos).
 */
export function summarizeTemplate(t) {
  const comps = t.components || [];
  const body = comps.find((c) => c.type === 'BODY');
  const header = comps.find((c) => c.type === 'HEADER');
  const buttons = comps.find((c) => c.type === 'BUTTONS')?.buttons || [];
  const bodyText = body?.text || '';
  const vars = templateVars(bodyText);
  const named = t.parameter_format === 'NAMED' || vars.some((v) => !/^\d+$/.test(v));
  const headerOk = !header || (header.format === 'TEXT' && templateVars(header.text).length === 0);
  const buttonsOk = buttons.every((b) => b.type !== 'URL' || templateVars(b.url).length === 0);
  return {
    name: t.name,
    language: t.language,
    status: t.status,
    category: t.category,
    bodyText,
    vars,
    named,
    quickReplies: buttons.filter((b) => b.type === 'QUICK_REPLY').map((b) => b.text),
    usable: headerOk && buttonsOk,
  };
}

/** Parámetros del cuerpo listos para la API (posicionales o con nombre). */
export function bodyParameters(vars, values, named) {
  return vars.map((v, i) => {
    const text = String(values[i] ?? '').trim().slice(0, 300) || '-';
    return named ? { type: 'text', parameter_name: v, text } : { type: 'text', text };
  });
}

/** Texto final tal como lo verá el cliente (para guardarlo en el hilo). */
export function renderTemplate(bodyText, vars, values) {
  let out = String(bodyText || '');
  vars.forEach((v, i) => {
    out = out.split(new RegExp(`\\{\\{\\s*${v}\\s*\\}\\}`)).join(String(values[i] ?? '').trim() || '-');
  });
  return out;
}

/**
 * Valores de variables con marcadores: {nombre} → primer nombre del cliente
 * (o `fallback` si no lo sabemos).
 */
export function fillPlaceholders(values, { customerName = '', fallback = 'cliente' } = {}) {
  const first = String(customerName || '').trim().split(/\s+/)[0] || fallback;
  return (values || []).map((v) => String(v || '').replace(/\{nombre\}/gi, first));
}
