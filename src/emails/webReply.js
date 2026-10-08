/**
 * Aviso al VISITANTE del chat web: el equipo del negocio le respondió y él ya no
 * tenía la página abierta. Lleva la respuesta y un enlace para volver al sitio.
 *
 * @param {object} p
 * @param {string} p.businessName
 * @param {string} [p.customerName]
 * @param {string} p.text   Respuesta del equipo.
 * @param {string} [p.site] Dominio donde está el chat (p. ej. "mitienda.com").
 * @returns {{ subject: string, html: string }}
 */
export function webReplyEmail(p) {
  const ink = '#0f172a';
  const muted = '#64748b';
  const line = '#e2e8f0';
  const bg = '#f1f5f9';
  const biz = escapeHtml(p.businessName || 'El negocio');
  const greet = p.customerName ? `Hola ${escapeHtml(p.customerName)},` : 'Hola,';
  const text = escapeHtml(String(p.text || '').slice(0, 3000)).replace(/\n/g, '<br>');
  const url = p.site ? `https://${p.site}` : '';
  const subject = `${p.businessName || 'El negocio'} respondió tu mensaje`;

  const html = `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${bg};font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${bg};padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid ${line};border-radius:16px;overflow:hidden;">
        <tr><td style="padding:24px 28px 0;">
          <h1 style="margin:0 0 6px;font-size:20px;color:${ink};">${biz} te respondió</h1>
          <p style="margin:0;color:${muted};font-size:14px;line-height:1.6;">${greet} escribiste en el chat del sitio${p.site ? ` <b>${escapeHtml(p.site)}</b>` : ''} y esta es su respuesta:</p>
        </td></tr>
        <tr><td style="padding:16px 28px 4px;">
          <div style="background:#f8fafc;border:1px solid ${line};border-radius:12px;padding:14px 16px;color:${ink};font-size:15px;line-height:1.6;">${text}</div>
        </td></tr>
        <tr><td style="padding:16px 28px 24px;">
          ${url ? `<a href="${url}" style="display:inline-block;background:${ink};color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 20px;border-radius:10px;">Continuar en el chat</a>` : ''}
          <p style="margin:14px 0 0;color:${muted};font-size:12px;line-height:1.6;">Para responder, vuelve a escribir en el chat del sitio. Este correo no recibe respuestas.</p>
        </td></tr>
        <tr><td style="padding:14px 28px 22px;border-top:1px solid ${line};">
          <p style="margin:0;color:#94a3b8;font-size:12px;">Te escribimos porque dejaste este correo en el chat de ${biz}. Chat con tecnología de RenBotIA.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  return { subject, html };
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
