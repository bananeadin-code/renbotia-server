/**
 * Aviso interno al equipo comercial: alguien se registró (para la conexión
 * asistida). Llega a SALES_ALERT_EMAILS.
 */
export function newLeadEmail({ name, email, channel, campaign, url }) {
  const subject = `Nuevo registro: ${plain(name)} (${plain(channel)})`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#0F172A;max-width:520px">
  <div style="font-size:12px;font-weight:bold;letter-spacing:.08em;color:#0E8A68;text-transform:uppercase">Nuevo registro</div>
  <h2 style="margin:6px 0 14px;font-size:22px">${esc(name)}</h2>
  <table style="border-collapse:collapse;font-size:14px">
    <tr><td style="color:#64748B;padding:4px 14px 4px 0">Correo</td><td><a href="mailto:${esc(email)}" style="color:#0E8A68">${esc(email)}</a></td></tr>
    <tr><td style="color:#64748B;padding:4px 14px 4px 0">Llegó por</td><td>${esc(channel)}</td></tr>
    ${campaign ? `<tr><td style="color:#64748B;padding:4px 14px 4px 0">Campaña</td><td>${esc(campaign)}</td></tr>` : ''}
  </table>
  <p style="margin:18px 0">Contáctalo en las próximas horas: ofrécele la conexión asistida de su WhatsApp. Es el paso que más decide si se vuelve cliente.</p>
  <a href="${esc(url)}" style="display:inline-block;background:#0A6B4F;color:#fff;text-decoration:none;font-weight:bold;padding:10px 16px;border-radius:8px">Abrir en el embudo</a>
</div>`;
  return { subject, html };
}

function esc(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function plain(s = '') {
  return String(s).replace(/\s+/g, ' ').trim();
}
