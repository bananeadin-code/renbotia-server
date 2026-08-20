/**
 * Normalización y validación de teléfonos a formato E.164, priorizando México.
 * No depende de librerías externas (suficiente para el MVP; a futuro se puede
 * cambiar por libphonenumber para cobertura internacional completa).
 */

/**
 * Normaliza un número a E.164 (ej. +526181234567). Reglas:
 *  - Limpia espacios, guiones y paréntesis.
 *  - "00" inicial → prefijo internacional "+".
 *  - Si ya trae "+", respeta el código de país.
 *  - 10 dígitos sin "+" → se asume México (+52).
 *  - 12 dígitos que empiezan con 52 → +52…
 *  - 11 dígitos que empiezan con 1 → +1… (Norteamérica).
 *
 * @param {string} raw
 * @returns {{ ok: boolean, e164?: string, reason?: string }}
 */
export function normalizePhone(raw) {
  if (!raw || typeof raw !== 'string') return { ok: false, reason: 'Ingresa un número.' };

  let s = raw.trim().replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);

  const digits = s.replace(/\D/g, '');

  if (s.startsWith('+')) {
    // trae país explícito
  } else if (digits.length === 10) {
    s = '+52' + digits; // México por defecto
  } else if (digits.length === 12 && digits.startsWith('52')) {
    s = '+' + digits;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    s = '+' + digits;
  } else {
    return {
      ok: false,
      reason: 'Formato no reconocido. Usa 10 dígitos (México) o incluye el código de país con "+".',
    };
  }

  if (!/^\+[1-9]\d{7,14}$/.test(s)) {
    return { ok: false, reason: 'El número no parece válido.' };
  }
  // México: exactamente +52 seguido de 10 dígitos.
  if (s.startsWith('+52') && !/^\+52\d{10}$/.test(s)) {
    return { ok: false, reason: 'Un número de México debe tener 10 dígitos después de +52.' };
  }

  return { ok: true, e164: s };
}

/** ¿Es un número mexicano válido (+52 + 10 dígitos)? */
export function isMexican(e164) {
  return /^\+52\d{10}$/.test(e164 || '');
}
