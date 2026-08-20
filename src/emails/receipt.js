import { env } from '../config/env.js';

/**
 * Plantilla HTML de un comprobante de compra (RenBotIA).
 * NO es un comprobante fiscal (sin RFC/CFDI): es una confirmación de compra.
 * Estilos inline y tabla para máxima compatibilidad con clientes de correo.
 *
 * @param {object} p
 * @param {string} [p.customerName]  Nombre del cliente (saludo).
 * @param {string} [p.businessName]  Nombre del negocio del cliente.
 * @param {'plan'|'credits'} p.type
 * @param {string} p.description     Concepto (ej. "Plan Elite", "1 millón de créditos").
 * @param {number} p.amountMXN
 * @param {number} [p.tokens]        Créditos acreditados (compras de créditos).
 * @param {Date}   [p.date]
 * @param {string} [p.reference]     Referencia del pago (id de Stripe).
 * @param {boolean}[p.auto]          Si fue una recarga automática.
 * @param {number} [p.availableAfter] Saldo disponible tras la compra (créditos).
 * @returns {{ subject: string, html: string }}
 */
export function receiptEmail(p) {
  const brand = '#0f9d6e'; // emerald 600 (marca RenBotIA)
  const ink = '#0f172a';
  const muted = '#64748b';
  const line = '#e2e8f0';
  const bg = '#f1f5f9';

  const date = (p.date || new Date()).toLocaleString('es-MX', {
    dateStyle: 'long',
    timeStyle: 'short',
  });
  const money = `$${Number(p.amountMXN).toLocaleString('es-MX')} MXN`;
  const isCredits = p.type === 'credits';
  const tokensStr =
    isCredits && p.tokens ? `${Number(p.tokens).toLocaleString('es-MX')} créditos` : '';
  const ref = p.reference ? p.reference.replace(/^autopi_/, '') : '';
  const greetName = p.customerName ? `Hola ${escapeHtml(p.customerName)},` : 'Hola,';

  const subject = p.auto
    ? `Recarga automática confirmada — ${money}`
    : `Comprobante de compra — ${escapeHtml(p.description)}`;

  const row = (label, value) => `
    <tr>
      <td style="padding:10px 0;color:${muted};font-size:14px;">${label}</td>
      <td style="padding:10px 0;color:${ink};font-size:14px;font-weight:600;text-align:right;">${value}</td>
    </tr>`;

  const dashboardUrl = `${env.publicUrl.replace(/\/$/, '')}/dashboard/facturacion`;

  const html = `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${bg};font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${bg};padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid ${line};border-radius:16px;overflow:hidden;">
        <!-- Encabezado -->
        <tr>
          <td style="padding:24px 28px 8px;">
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td style="width:34px;height:34px;background:${brand};border-radius:9px;text-align:center;vertical-align:middle;color:#fff;font-weight:800;font-size:18px;">R</td>
              <td style="padding-left:10px;font-weight:800;font-size:18px;color:${ink};">RenBotIA</td>
            </tr></table>
          </td>
        </tr>
        <!-- Estado -->
        <tr>
          <td style="padding:8px 28px 0;">
            <div style="display:inline-block;background:#ecfdf5;color:${brand};font-size:12px;font-weight:700;padding:5px 10px;border-radius:999px;">
              ${p.auto ? 'Recarga automática' : 'Pago confirmado'}
            </div>
            <h1 style="margin:14px 0 4px;font-size:22px;color:${ink};">${escapeHtml(p.description)}</h1>
            <p style="margin:0 0 4px;color:${muted};font-size:14px;">${greetName} gracias por tu compra. Aquí está tu comprobante.</p>
          </td>
        </tr>
        <!-- Detalle -->
        <tr>
          <td style="padding:16px 28px 4px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${line};">
              ${row('Concepto', escapeHtml(p.description))}
              ${tokensStr ? row('Créditos acreditados', tokensStr) : ''}
              ${
                isCredits && typeof p.availableAfter === 'number'
                  ? row('Saldo disponible', `${p.availableAfter.toLocaleString('es-MX')} créditos`)
                  : ''
              }
              ${p.businessName ? row('Negocio', escapeHtml(p.businessName)) : ''}
              ${row('Fecha', date)}
              ${ref ? row('Referencia', `<span style="font-family:ui-monospace,Menlo,monospace;font-size:12px;">${escapeHtml(ref)}</span>`) : ''}
            </table>
          </td>
        </tr>
        <!-- Total -->
        <tr>
          <td style="padding:8px 28px 20px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid ${line};">
              <tr>
                <td style="padding:14px 0 0;color:${ink};font-size:16px;font-weight:700;">Total pagado</td>
                <td style="padding:14px 0 0;color:${brand};font-size:20px;font-weight:800;text-align:right;">${money}</td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- CTA -->
        <tr>
          <td style="padding:0 28px 24px;">
            <a href="${dashboardUrl}" style="display:inline-block;background:${brand};color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 18px;border-radius:10px;">Ver mi facturación</a>
          </td>
        </tr>
        <!-- Nota -->
        <tr>
          <td style="padding:16px 28px 24px;border-top:1px solid ${line};">
            <p style="margin:0;color:${muted};font-size:12px;line-height:1.6;">
              Este correo es una confirmación de tu compra, no un comprobante fiscal (CFDI).
              Si necesitas facturación fiscal, respóndenos a este correo.
            </p>
            <p style="margin:10px 0 0;color:#94a3b8;font-size:12px;">© ${new Date().getFullYear()} RenBotIA · Asistentes de WhatsApp con IA</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, html };
}

/** Escapa texto para insertarlo con seguridad en el HTML del correo. */
function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
