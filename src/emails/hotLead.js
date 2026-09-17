import { env } from '../config/env.js';

/**
 * Email "tienes un lead caliente": el bot detectó ALTA intención de compra o
 * contratación en una conversación (una OPORTUNIDAD de venta). Invita al dueño a
 * dar seguimiento prioritario desde el panel de Conversaciones. Distinto del
 * aviso de escalación (queja/urgencia): este es positivo.
 *
 * @param {object} p
 * @param {string} [p.customerName]  nombre del dueño (saludo)
 * @param {string} [p.businessName]
 * @param {string} [p.reason]        señal de compra detectada
 * @param {string} [p.contactName]   nombre del cliente que escribió (si se sabe)
 * @param {string} [p.preview]       último mensaje del cliente (recorte)
 * @returns {{ subject: string, html: string }}
 */
export function hotLeadEmail(p) {
  const brand = '#0f9d6e';
  const ink = '#0f172a';
  const muted = '#64748b';
  const line = '#e2e8f0';
  const bg = '#f1f5f9';

  const greetName = p.customerName ? `Hola ${escapeHtml(p.customerName)},` : 'Hola,';
  const convUrl = `${env.publicUrl.replace(/\/$/, '')}/dashboard/conversaciones`;
  const subject = `Tienes un lead caliente${p.businessName ? ` — ${escapeHtml(p.businessName)}` : ''}`;

  const reason = p.reason
    ? escapeHtml(p.reason)
    : 'El bot detectó alta intención de compra en esta conversación.';
  const who = p.contactName ? escapeHtml(p.contactName) : 'Un cliente';
  const preview = p.preview ? escapeHtml(p.preview) : '';

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
          <div style="display:inline-block;background:#ecfdf5;color:#047857;font-size:12px;font-weight:700;padding:5px 10px;border-radius:999px;">Lead caliente</div>
          <h1 style="margin:14px 0 4px;font-size:22px;color:${ink};">Un cliente está listo para avanzar</h1>
          <p style="margin:0 0 4px;color:${muted};font-size:14px;line-height:1.6;">${greetName} ${who} en tu WhatsApp${p.businessName ? ` de <b>${escapeHtml(p.businessName)}</b>` : ''} mostró alta intención de compra. Dale seguimiento pronto para no perder la oportunidad.</p>
        </td></tr>
        <tr><td style="padding:16px 28px 4px;">
          <div style="background:#f8fafc;border:1px solid ${line};border-radius:12px;padding:16px;">
            <div style="color:${muted};font-size:12px;text-transform:uppercase;letter-spacing:.04em;">Señal detectada</div>
            <div style="color:${ink};font-size:14px;font-weight:600;margin-top:4px;">${reason}</div>
            ${preview ? `<div style="color:${muted};font-size:13px;margin-top:10px;padding-top:10px;border-top:1px solid ${line};">“${preview}”</div>` : ''}
          </div>
        </td></tr>
        <tr><td style="padding:18px 28px 24px;">
          <a href="${convUrl}" style="display:inline-block;background:${brand};color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 20px;border-radius:10px;">Ver la conversación</a>
          <p style="margin:14px 0 0;color:${muted};font-size:12px;line-height:1.6;">En <b>Conversaciones</b> aparece resaltada como <b>lead caliente</b>. Puedes tomar el control en <b>Manual</b> y cerrar tú mismo.</p>
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
