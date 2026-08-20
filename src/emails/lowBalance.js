import { env } from '../config/env.js';

/**
 * Email de aviso "te quedan pocos créditos", con CTA a comprar. Evita que el bot
 * se "apague" sin avisar (la queja más común en modelos por créditos).
 *
 * @param {object} p
 * @param {string} [p.customerName]
 * @param {string} [p.businessName]
 * @param {number} p.available   Créditos disponibles.
 * @param {string} [p.planName]
 * @returns {{ subject: string, html: string }}
 */
export function lowBalanceEmail(p) {
  const brand = '#0f9d6e';
  const ink = '#0f172a';
  const muted = '#64748b';
  const line = '#e2e8f0';
  const bg = '#f1f5f9';

  const available = Number(p.available || 0).toLocaleString('es-MX');
  const greetName = p.customerName ? `Hola ${escapeHtml(p.customerName)},` : 'Hola,';
  const billingUrl = `${env.publicUrl.replace(/\/$/, '')}/dashboard/facturacion`;
  const subject = `Te quedan pocos créditos${p.businessName ? ` — ${escapeHtml(p.businessName)}` : ''}`;

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
          <div style="display:inline-block;background:#fff7ed;color:#b45309;font-size:12px;font-weight:700;padding:5px 10px;border-radius:999px;">Crédito bajo</div>
          <h1 style="margin:14px 0 4px;font-size:22px;color:${ink};">Tu bot está por quedarse sin créditos</h1>
          <p style="margin:0 0 4px;color:${muted};font-size:14px;line-height:1.6;">${greetName} a tu bot${p.businessName ? ` de <b>${escapeHtml(p.businessName)}</b>` : ''} le quedan <b>${available} créditos</b>. Cuando se agoten, dejará de responder a tus clientes hasta que recargues o renueve tu plan.</p>
        </td></tr>
        <tr><td style="padding:16px 28px 4px;">
          <div style="background:#f8fafc;border:1px solid ${line};border-radius:12px;padding:16px;text-align:center;">
            <div style="color:${muted};font-size:12px;text-transform:uppercase;letter-spacing:.04em;">Créditos disponibles</div>
            <div style="color:${brand};font-size:28px;font-weight:800;margin-top:4px;">${available}</div>
          </div>
        </td></tr>
        <tr><td style="padding:18px 28px 24px;">
          <a href="${billingUrl}" style="display:inline-block;background:${brand};color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 20px;border-radius:10px;">Comprar más créditos</a>
          <p style="margin:14px 0 0;color:${muted};font-size:12px;line-height:1.6;">¿Prefieres no volver a quedarte sin servicio? Activa la <b>recarga automática</b> en tu panel y compramos créditos por ti antes de que se agoten.</p>
        </td></tr>
        <tr><td style="padding:16px 28px 24px;border-top:1px solid ${line};">
          <p style="margin:0;color:#94a3b8;font-size:12px;">© ${new Date().getFullYear()} RenBotIA · Asistentes de WhatsApp con IA</p>
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
