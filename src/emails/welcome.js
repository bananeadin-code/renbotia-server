import { env } from '../config/env.js';

/**
 * Correo de bienvenida (cálido) al activar la cuenta. Tono cercano y humano.
 * @param {{ customerName?: string }} p
 * @returns {{ subject: string, html: string }}
 */
export function welcomeEmail(p) {
  const brand = '#0f9d6e';
  const ink = '#0f172a';
  const muted = '#64748b';
  const line = '#e2e8f0';
  const bg = '#f1f5f9';
  const first = (p.customerName || '').trim().split(' ')[0];
  const greet = first ? `¡Hola, ${escapeHtml(first)}!` : '¡Hola!';
  const dashUrl = `${env.publicUrl.replace(/\/$/, '')}/dashboard`;

  const subject = first ? `¡Bienvenido a RenBotIA, ${first}!` : '¡Bienvenido a RenBotIA!';
  const html = `
  <div style="background:${bg};padding:24px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border:1px solid ${line};border-radius:14px;overflow:hidden;">
        <tr><td style="padding:28px 32px 8px;">
          <div style="font-size:18px;font-weight:800;color:${ink};letter-spacing:-0.3px;">RenBot<span style="color:${brand};">IA</span></div>
        </td></tr>
        <tr><td style="padding:8px 32px 4px;">
          <h1 style="margin:0 0 10px;font-size:22px;color:${ink};">${greet}</h1>
          <p style="margin:0 0 14px;color:${muted};font-size:15px;line-height:1.65;">
            Qué gusto tenerte aquí. Tu cuenta ya está lista, y con RenBotIA vas a tener un asistente
            de WhatsApp con inteligencia artificial que atiende a tus clientes, responde dudas y te
            ayuda a no perder ninguna venta — aunque estés ocupado o sea de madrugada.
          </p>
          <p style="margin:0 0 20px;color:${muted};font-size:15px;line-height:1.65;">
            Para empezar, entrena tu bot con la info de tu negocio y pruébalo en el simulador. En
            unos minutos lo tendrás listo.
          </p>
          <a href="${dashUrl}" style="display:inline-block;background:${brand};color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 24px;border-radius:10px;">Ir a mi panel</a>
          <p style="margin:22px 0 0;color:${muted};font-size:13px;line-height:1.6;">
            ¿Dudas? Responde a este correo y con gusto te ayudamos. Estamos para apoyarte.
          </p>
        </td></tr>
        <tr><td style="padding:20px 32px 28px;">
          <hr style="border:none;border-top:1px solid ${line};margin:0 0 12px;">
          <p style="margin:0;color:${muted};font-size:12px;">RenBotIA · Asistentes de WhatsApp con IA · Hecho en México</p>
        </td></tr>
      </table>
    </td></tr></table>
  </div>`;

  return { subject, html };
}

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
