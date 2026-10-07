import { env } from '../config/env.js';

/**
 * "Ganaste 1 mes de Pro": se manda al completar 3 negocios invitados.
 * @param {{ customerName?: string, kind: 'trial'|'credits', credits?: number }} p
 */
export function referralRewardEmail(p) {
  const brand = '#0f9d6e';
  const ink = '#0f172a';
  const muted = '#64748b';
  const line = '#e2e8f0';
  const bg = '#f1f5f9';
  const url = `${env.publicUrl.replace(/\/$/, '')}/dashboard`;
  const greet = p.customerName ? `¡Felicidades, ${escapeHtml(p.customerName.split(' ')[0])}!` : '¡Felicidades!';
  const body =
    p.kind === 'trial'
      ? 'Tres negocios ya usan RenBotIA gracias a ti. Activamos <b>un mes de Pro gratis</b> en tu cuenta: 20 veces más conversaciones, tono y personalidad a tu medida, chat para tu sitio web y seguimiento automático. Al terminar el mes vuelves a Free, sin cargos.'
      : `Tres negocios ya usan RenBotIA gracias a ti. Como ya tienes un plan de pago, te dimos <b>${Number(p.credits || 0).toLocaleString('es-MX')} créditos</b> (un mes de Pro) que no caducan.`;
  const subject = 'Ganaste 1 mes de Pro en RenBotIA';
  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${bg};font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${bg};padding:24px 12px;"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border:1px solid ${line};border-radius:16px;overflow:hidden;">
      <tr><td style="padding:24px 28px 8px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="width:34px;height:34px;background:${brand};border-radius:9px;text-align:center;vertical-align:middle;color:#fff;font-weight:800;font-size:18px;">R</td>
          <td style="padding-left:10px;font-weight:800;font-size:18px;color:${ink};">RenBotIA</td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:8px 28px 0;">
        <div style="display:inline-block;background:#ecfdf5;color:#047857;font-size:12px;font-weight:700;padding:5px 10px;border-radius:999px;">Invita y gana</div>
        <h1 style="margin:14px 0 4px;font-size:22px;color:${ink};">${greet}</h1>
        <p style="margin:0;color:${muted};font-size:14px;line-height:1.6;">${body}</p>
      </td></tr>
      <tr><td style="padding:18px 28px 24px;">
        <a href="${url}" style="display:inline-block;background:${brand};color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 20px;border-radius:10px;">Ir a mi panel</a>
        <p style="margin:14px 0 0;color:${muted};font-size:12px;">Gracias por recomendarnos. Tu enlace sigue activo para que más negocios lo conozcan.</p>
      </td></tr>
      <tr><td style="padding:16px 28px 24px;border-top:1px solid ${line};">
        <p style="margin:0;color:#94a3b8;font-size:12px;">© ${new Date().getFullYear()} RenBotIA</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  return { subject, html };
}

function escapeHtml(str = '') {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
