/**
 * Lectura sencilla del user-agent para mostrar "Chrome en Windows" en la lista de
 * sesiones y en los avisos de inicio de sesión. No es un parser exhaustivo: solo
 * lo necesario para que la persona reconozca su dispositivo.
 */

const BROWSERS = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/CriOS\/|Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

const SYSTEMS = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'Mac'],
  [/CrOS/, 'Chromebook'],
  [/Linux/, 'Linux'],
];

const pick = (list, ua) => list.find(([re]) => re.test(ua))?.[1] || '';

/** @returns {{ browser: string, os: string, label: string }} */
export function describeDevice(userAgent = '') {
  const ua = String(userAgent || '');
  const browser = pick(BROWSERS, ua) || 'Navegador';
  const os = pick(SYSTEMS, ua) || 'dispositivo desconocido';
  return { browser, os, label: `${browser} en ${os}` };
}

/** Nombre de país para mostrar a partir del código ISO de Cloudflare (MX → México). */
export function countryName(code = '') {
  const c = String(code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(c) || c === 'XX' || c === 'T1') return '';
  try {
    return new Intl.DisplayNames(['es'], { type: 'region' }).of(c) || c;
  } catch {
    return c;
  }
}
