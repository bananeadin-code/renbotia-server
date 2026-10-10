/**
 * Avisos de seguridad de la cuenta:
 *  - new_login:      inicio de sesión desde un dispositivo nuevo.
 *  - session_reuse:  se detectó el uso de una sesión robada/copiada y se cerró.
 *  - account_locked: varios intentos fallidos de contraseña → bloqueo temporal.
 *  - passkey_added / passkey_removed: se agregó o quitó una llave de acceso.
 *  - two_factor_off: se apagó la verificación en dos pasos.
 *
 * @param {object} p
 * @param {'new_login'|'session_reuse'|'account_locked'} p.kind
 * @param {string} [p.customerName]
 * @param {string} [p.device]   "Chrome en Windows"
 * @param {string} [p.place]    "México"
 * @param {Date}   [p.when]
 * @param {number} [p.minutes] minutos de bloqueo
 * @param {string} p.url        enlace a Perfil → Seguridad
 * @param {string} p.resetUrl   enlace para restablecer la contraseña
 * @returns {{ subject: string, html: string }}
 */
export function securityEmail(p) {
  const ink = '#0f172a';
  const muted = '#64748b';
  const line = '#e2e8f0';
  const bg = '#f1f5f9';
  const brand = '#0f9d6e';
  const greet = p.customerName ? `Hola ${escapeHtml(p.customerName)},` : 'Hola,';
  const when = (p.when || new Date()).toLocaleString('es-MX', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'America/Mexico_City',
  });
  const where = [p.device, p.place].filter(Boolean).map(escapeHtml).join(' · ');

  const v = {
    new_login: {
      tag: ['Nuevo inicio de sesión', '#eff6ff', '#1d4ed8'],
      subject: 'Nuevo inicio de sesión en tu cuenta de RenBotIA',
      title: 'Iniciaste sesión desde un dispositivo nuevo',
      body: `${greet} alguien entró a tu cuenta desde <b>${where || 'un dispositivo nuevo'}</b> el ${when}. Si fuiste tú, no tienes que hacer nada.`,
      warn: 'Si no fuiste tú, cambia tu contraseña de inmediato y cierra las sesiones que no reconozcas.',
      cta: 'Revisar mis sesiones',
    },
    session_reuse: {
      tag: ['Sesión cerrada por seguridad', '#fef2f2', '#b91c1c'],
      subject: 'Cerramos una sesión de tu cuenta por seguridad',
      title: 'Detectamos el uso de una sesión copiada',
      body: `${greet} alguien intentó usar una sesión de tu cuenta (${where || 'dispositivo desconocido'}) que ya había sido renovada. Es una señal de que la sesión pudo ser copiada, así que la cerramos el ${when}.`,
      warn: 'Por precaución, cambia tu contraseña y revisa tus sesiones activas.',
      cta: 'Revisar mis sesiones',
    },
    passkey_added: {
      tag: ['Llave de acceso agregada', '#ecfdf5', '#047857'],
      subject: 'Agregaste una llave de acceso a tu cuenta de RenBotIA',
      title: 'Nueva llave de acceso',
      body: `${greet} el ${when} se agregó una llave de acceso (<b>${escapeHtml(p.device || 'nuevo dispositivo')}</b>). Desde ahí puedes entrar con tu huella, cara o PIN.`,
      warn: 'Si no fuiste tú, entra a tu cuenta, quita esa llave y cambia tu contraseña.',
      cta: 'Ver mis llaves de acceso',
    },
    passkey_removed: {
      tag: ['Llave de acceso eliminada', '#f8fafc', '#334155'],
      subject: 'Quitaste una llave de acceso de tu cuenta de RenBotIA',
      title: 'Se quitó una llave de acceso',
      body: `${greet} el ${when} se quitó la llave de acceso <b>${escapeHtml(p.device || '')}</b>. Ese dispositivo ya no puede entrar sin contraseña.`,
      warn: 'Si no fuiste tú, cambia tu contraseña y revisa tus sesiones.',
      cta: 'Revisar mi seguridad',
    },
    two_factor_off: {
      tag: ['Verificación en dos pasos apagada', '#fff7ed', '#b45309'],
      subject: 'Apagaste la verificación en dos pasos de tu cuenta',
      title: 'La verificación en dos pasos está apagada',
      body: `${greet} el ${when} se apagó la verificación en dos pasos (${where || 'desde tu panel'}). Ahora solo la contraseña protege tu cuenta.`,
      warn: 'Si no fuiste tú, cambia tu contraseña y vuelve a encenderla en Perfil → Seguridad.',
      cta: 'Revisar mi seguridad',
    },
    account_locked: {
      tag: ['Cuenta bloqueada', '#fff7ed', '#b45309'],
      subject: 'Bloqueamos temporalmente el acceso a tu cuenta',
      title: 'Varios intentos fallidos de contraseña',
      body: `${greet} hubo varios intentos fallidos de iniciar sesión en tu cuenta, así que bloqueamos el acceso durante ${p.minutes || 15} minutos (${when}).`,
      warn: 'Si no fuiste tú, alguien podría estar intentando adivinar tu contraseña: cámbiala por una más segura.',
      cta: 'Cambiar mi contraseña',
    },
  }[p.kind];

  const ctaUrl = p.kind === 'account_locked' ? p.resetUrl : p.url;
  const html = `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${bg};font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${bg};padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid ${line};border-radius:16px;overflow:hidden;">
        <tr><td style="padding:24px 28px 8px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="width:34px;height:34px;background:${brand};border-radius:9px;text-align:center;vertical-align:middle;color:#fff;font-weight:800;font-size:18px;">R</td>
            <td style="padding-left:10px;font-weight:800;font-size:18px;color:${ink};">RenBotIA</td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:8px 28px 0;">
          <div style="display:inline-block;background:${v.tag[1]};color:${v.tag[2]};font-size:12px;font-weight:700;padding:5px 10px;border-radius:999px;">${v.tag[0]}</div>
          <h1 style="margin:14px 0 6px;font-size:21px;color:${ink};">${v.title}</h1>
          <p style="margin:0 0 10px;color:${muted};font-size:14px;line-height:1.6;">${v.body}</p>
          <p style="margin:0;color:${ink};font-size:14px;line-height:1.6;"><b>${v.warn}</b></p>
        </td></tr>
        <tr><td style="padding:18px 28px 24px;">
          <a href="${ctaUrl}" style="display:inline-block;background:${brand};color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 20px;border-radius:10px;">${v.cta}</a>
          <p style="margin:14px 0 0;color:${muted};font-size:12px;line-height:1.6;">RenBotIA nunca te pedirá tu contraseña ni tus códigos por correo, WhatsApp o teléfono.</p>
        </td></tr>
        <tr><td style="padding:16px 28px 24px;border-top:1px solid ${line};">
          <p style="margin:0;color:#94a3b8;font-size:12px;">© ${new Date().getFullYear()} RenBotIA · Aviso de seguridad automático</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  return { subject: v.subject, html };
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
