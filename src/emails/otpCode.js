/**
 * Plantilla del correo con el código de verificación (OTP) de 6 dígitos.
 * @param {{ code: string, purpose: 'verify_email'|'login_2fa', customerName?: string, minutes?: number }} p
 * @returns {{ subject: string, html: string }}
 */
export function otpCodeEmail(p) {
  const brand = '#0f9d6e';
  const ink = '#0f172a';
  const muted = '#64748b';
  const line = '#e2e8f0';
  const bg = '#f1f5f9';
  const minutes = p.minutes || 10;
  const greet = p.customerName ? `Hola ${escapeHtml(p.customerName)},` : 'Hola,';

  const isLogin = p.purpose === 'login_2fa';
  const subject = isLogin
    ? `Tu código de acceso: ${p.code}`
    : `Confirma tu correo: ${p.code}`;
  const intro = isLogin
    ? 'Usa este código para completar tu inicio de sesión en RenBotIA.'
    : 'Usa este código para confirmar tu correo y activar tu cuenta de RenBotIA.';

  const html = `
  <div style="background:${bg};padding:24px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border:1px solid ${line};border-radius:14px;overflow:hidden;">
        <tr><td style="padding:28px 32px 8px;">
          <div style="font-size:18px;font-weight:800;color:${ink};letter-spacing:-0.3px;">RenBot<span style="color:${brand};">IA</span></div>
        </td></tr>
        <tr><td style="padding:8px 32px 4px;">
          <p style="margin:0 0 4px;color:${ink};font-size:14px;">${greet}</p>
          <p style="margin:0 0 18px;color:${muted};font-size:14px;line-height:1.6;">${intro}</p>
          <div style="text-align:center;margin:8px 0 18px;">
            <span style="display:inline-block;background:${bg};border:1px solid ${line};border-radius:12px;padding:14px 26px;font-size:30px;font-weight:800;letter-spacing:8px;color:${ink};">${escapeHtml(p.code)}</span>
          </div>
          <p style="margin:0;color:${muted};font-size:12px;line-height:1.6;">
            El código vence en ${minutes} minutos. Si no fuiste tú, ignora este correo.
          </p>
        </td></tr>
        <tr><td style="padding:20px 32px 28px;">
          <hr style="border:none;border-top:1px solid ${line};margin:0 0 12px;">
          <p style="margin:0;color:${muted};font-size:12px;">RenBotIA · Bots de WhatsApp con IA</p>
        </td></tr>
      </table>
    </td></tr></table>
  </div>`;

  return { subject, html };
}

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
