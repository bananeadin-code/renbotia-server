/**
 * Plantilla HTML del correo para restablecer la contraseña (RenBotIA).
 * Estilos inline para máxima compatibilidad con clientes de correo.
 *
 * @param {object} p
 * @param {string} [p.customerName]  Nombre del usuario (saludo).
 * @param {string} p.link            Enlace con el token de restablecimiento.
 * @param {number} [p.minutes]       Minutos de validez del enlace (default 30).
 * @returns {{ subject: string, html: string }}
 */
export function passwordResetEmail(p) {
  const brand = '#0f9d6e';
  const ink = '#0f172a';
  const muted = '#64748b';
  const line = '#e2e8f0';
  const bg = '#f1f5f9';
  const minutes = p.minutes || 30;
  const greet = p.customerName ? `Hola ${escapeHtml(p.customerName)},` : 'Hola,';

  const subject = 'Restablece tu contraseña de RenBotIA';
  const html = `
  <div style="background:${bg};padding:24px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border:1px solid ${line};border-radius:14px;overflow:hidden;">
          <tr><td style="padding:28px 32px 8px;">
            <div style="font-size:18px;font-weight:800;color:${ink};letter-spacing:-0.3px;">RenBot<span style="color:${brand};">IA</span></div>
          </td></tr>
          <tr><td style="padding:8px 32px 4px;">
            <h1 style="margin:0 0 8px;font-size:20px;color:${ink};">Restablece tu contraseña</h1>
            <p style="margin:0 0 4px;color:${ink};font-size:14px;">${greet}</p>
            <p style="margin:0 0 20px;color:${muted};font-size:14px;line-height:1.6;">
              Recibimos una solicitud para restablecer tu contraseña. Haz clic en el botón para elegir una nueva. Este enlace vence en ${minutes} minutos.
            </p>
            <a href="${p.link}" style="display:inline-block;background:${brand};color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:10px;">Restablecer contraseña</a>
            <p style="margin:20px 0 0;color:${muted};font-size:12px;line-height:1.6;">
              Si no fuiste tú, ignora este correo: tu contraseña seguirá igual. Si el botón no funciona, copia y pega este enlace:<br>
              <span style="color:${brand};word-break:break-all;">${p.link}</span>
            </p>
          </td></tr>
          <tr><td style="padding:20px 32px 28px;">
            <hr style="border:none;border-top:1px solid ${line};margin:0 0 12px;">
            <p style="margin:0;color:${muted};font-size:12px;">RenBotIA · Bots de WhatsApp con IA</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </div>`;

  return { subject, html };
}

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
