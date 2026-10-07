import { env } from '../config/env.js';

/**
 * Resumen semanal "Aprende de ti": lo que el bot no supo o lo que el equipo
 * contestó a mano esta semana, para enseñárselo con un clic en Entrenamiento.
 *
 * @param {object} p
 * @param {string} [p.customerName]  nombre del dueño (saludo)
 * @param {string} [p.businessName]
 * @param {Array<{question:string, source:string}>} p.items  primeras sugerencias
 * @param {number} p.total           total pendiente
 * @returns {{ subject: string, html: string }}
 */
export function learningDigestEmail(p) {
  const brand = '#0f9d6e';
  const ink = '#0f172a';
  const muted = '#64748b';
  const line = '#e2e8f0';
  const bg = '#f1f5f9';

  const greetName = p.customerName ? `Hola ${escapeHtml(p.customerName)},` : 'Hola,';
  const url = `${env.publicUrl.replace(/\/$/, '')}/dashboard/entrenamiento#aprender`;
  const total = Number(p.total) || (p.items || []).length;
  const subject = `Tu bot tiene ${total} ${total === 1 ? 'cosa' : 'cosas'} por aprender${p.businessName ? ` — ${escapeHtml(p.businessName)}` : ''}`;
  const SOURCE = { agent: 'Lo contestaste tú', rating: 'Respuesta mal calificada', escalation: 'El bot no supo' };

  const rows = (p.items || [])
    .map(
      (it) => `<tr><td style="padding:10px 0;border-top:1px solid ${line};">
        <div style="color:${ink};font-size:14px;font-weight:600;">“${escapeHtml(it.question)}”</div>
        <div style="color:${muted};font-size:12px;margin-top:2px;">${SOURCE[it.source] || ''}</div>
      </td></tr>`
    )
    .join('');

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
          <div style="display:inline-block;background:#ecfdf5;color:#047857;font-size:12px;font-weight:700;padding:5px 10px;border-radius:999px;">Resumen semanal</div>
          <h1 style="margin:14px 0 4px;font-size:22px;color:${ink};">Enséñale ${total === 1 ? 'esto' : 'estas cosas'} a tu bot</h1>
          <p style="margin:0;color:${muted};font-size:14px;line-height:1.6;">${greetName} esta semana tu bot${p.businessName ? ` de <b>${escapeHtml(p.businessName)}</b>` : ''} se topó con preguntas que aún no domina. Revísalas y, con un clic, quedan como respuesta para la próxima vez.</p>
        </td></tr>
        <tr><td style="padding:12px 28px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
          ${total > (p.items || []).length ? `<p style="margin:8px 0 0;color:${muted};font-size:12px;">Y ${total - p.items.length} más.</p>` : ''}
        </td></tr>
        <tr><td style="padding:18px 28px 24px;">
          <a href="${url}" style="display:inline-block;background:${brand};color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 20px;border-radius:10px;">Enseñarle ahora</a>
          <p style="margin:14px 0 0;color:${muted};font-size:12px;line-height:1.6;">Toma un minuto: cada respuesta que agregas hace que el bot atienda mejor y te escriban menos para lo mismo.</p>
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
