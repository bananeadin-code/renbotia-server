/**
 * Email interno "nuevo mensaje de contacto": lo que llega a tu buzón cuando
 * alguien usa el formulario público /contacto. El reply_to se fija al correo de
 * quien escribe, para que puedas responderle directo desde tu bandeja.
 *
 * @param {object} p
 * @param {string} p.name
 * @param {string} p.email
 * @param {string} [p.topic]
 * @param {string} p.message
 * @returns {{ subject: string, html: string }}
 */
export function contactEmail(p) {
  const brand = '#0f9d6e';
  const ink = '#0f172a';
  const muted = '#64748b';
  const line = '#e2e8f0';
  const bg = '#f1f5f9';

  const name = escapeHtml(p.name || 'Sin nombre');
  const email = escapeHtml(p.email || '');
  const topic = p.topic ? escapeHtml(p.topic) : 'General';
  const message = escapeHtml(p.message || '').replace(/\n/g, '<br>');
  const subject = `Nuevo contacto (${topic}) — ${name}`;

  const html = `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${bg};font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${bg};padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${line};border-radius:16px;overflow:hidden;">
        <tr><td style="padding:22px 26px 6px;">
          <div style="display:inline-block;background:#ecfdf5;color:#047857;font-size:12px;font-weight:700;padding:5px 10px;border-radius:999px;">Contacto · ${topic}</div>
          <h1 style="margin:12px 0 2px;font-size:20px;color:${ink};">Nuevo mensaje desde el sitio</h1>
        </td></tr>
        <tr><td style="padding:10px 26px 4px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
            <tr><td style="color:${muted};padding:4px 0;width:90px;">Nombre</td><td style="color:${ink};font-weight:600;">${name}</td></tr>
            <tr><td style="color:${muted};padding:4px 0;">Correo</td><td><a href="mailto:${email}" style="color:${brand};font-weight:600;text-decoration:none;">${email}</a></td></tr>
            <tr><td style="color:${muted};padding:4px 0;">Tema</td><td style="color:${ink};">${topic}</td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:14px 26px 24px;">
          <div style="background:#f8fafc;border:1px solid ${line};border-radius:12px;padding:16px;color:${ink};font-size:14px;line-height:1.6;">${message}</div>
          <p style="margin:14px 0 0;color:${muted};font-size:12px;">Responde a este correo para contestarle directamente a ${name}.</p>
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
