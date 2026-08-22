/**
 * Bloqueo de correos DESECHABLES/temporales al registrarse. Corta el abuso más
 * común (crear muchas cuentas Free con correos de "10 minutos" para farmear
 * tokens gratis). No es exhaustiva —hay miles de dominios— pero cubre los más
 * usados; se puede ampliar agregando dominios a la lista.
 */
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com',
  'mailinator.net',
  '10minutemail.com',
  '10minutemail.net',
  '20minutemail.com',
  'guerrillamail.com',
  'guerrillamail.info',
  'guerrillamail.biz',
  'guerrillamail.org',
  'guerrillamail.net',
  'guerrillamail.de',
  'guerrillamailblock.com',
  'sharklasers.com',
  'grr.la',
  'spam4.me',
  'temp-mail.org',
  'tempmail.com',
  'tempmailo.com',
  'tempmail.net',
  'tempail.com',
  'tempr.email',
  'tmail.ws',
  'tmpmail.org',
  'throwawaymail.com',
  'throwaway.email',
  'yopmail.com',
  'yopmail.fr',
  'yopmail.net',
  'getnada.com',
  'nada.email',
  'trashmail.com',
  'trashmail.net',
  'dispostable.com',
  'fakeinbox.com',
  'maildrop.cc',
  'mailnesia.com',
  'mohmal.com',
  'emailondeck.com',
  'mintemail.com',
  'mytemp.email',
  'spamgourmet.com',
  'tempinbox.com',
  'mailcatch.com',
  'moakt.com',
  'inboxbear.com',
  'discard.email',
  'mail-temp.com',
  '1secmail.com',
  '1secmail.org',
  '1secmail.net',
  'emltmp.com',
  'burnermail.io',
  'mailtemp.info',
  'fakemail.net',
  'trbvm.com',
  'byom.de',
]);

/**
 * @param {string} email
 * @returns {boolean} true si el dominio del correo es de un servicio desechable.
 */
export function isDisposableEmail(email) {
  const domain = String(email || '')
    .toLowerCase()
    .trim()
    .split('@')[1];
  return Boolean(domain) && DISPOSABLE_DOMAINS.has(domain);
}
