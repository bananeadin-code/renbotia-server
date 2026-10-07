import { env } from '../config/env.js';

/**
 * Reporte semanal del lunes: lo que el bot hizo la semana pasada (en datos y en
 * pesos estimados), los leads calientes para llamar hoy y lo que el bot aún no
 * sabe (para enseñárselo con un clic). Reemplaza al antiguo resumen de
 * "Aprende de ti": ahora va dentro de este mismo correo.
 *
 * @param {object} p
 * @param {string} [p.customerName]  nombre del dueño (saludo)
 * @param {string} [p.businessName]
 * @param {object} p.impact          resultado de computeImpact() de la semana
 * @param {Array<{name:string, reason:string}>} p.leads  leads calientes abiertos (máx. 3)
 * @param {Array<{question:string}>} p.learning          pendientes por enseñar (máx. 3)
 * @param {number} p.learningTotal
 * @returns {{ subject: string, html: string }}
 */
export function weeklyReportEmail(p) {
  const brand = '#0f9d6e';
  const ink = '#0f172a';
  const muted = '#64748b';
  const line = '#e2e8f0';
  const bg = '#f1f5f9';
  const base = env.publicUrl.replace(/\/$/, '');
  const i = p.impact || {};
  const money = (n) => `$${Math.round(n || 0).toLocaleString('es-MX')}`;
  const greet = p.customerName ? `Hola ${escapeHtml(p.customerName.split(' ')[0])},` : 'Hola,';

  const headline =
    i.value?.total > 0
      ? `Tu bot generó ≈ ${money(i.value.total)} MXN la semana pasada`
      : `Tu bot atendió ${i.conversations || 0} ${i.conversations === 1 ? 'conversación' : 'conversaciones'} la semana pasada`;
  const subject = `${headline.replace('Tu bot', 'Tu bot de ' + (p.businessName || 'tu negocio')).slice(0, 110)}`;

  const stat = (value, label) => `<td style="padding:10px 6px;text-align:center;width:25%;">
      <div style="font-size:22px;font-weight:800;color:${ink};">${value}</div>
      <div style="font-size:11px;color:${muted};line-height:1.3;margin-top:2px;">${label}</div></td>`;
  const stats = [
    stat(i.conversations || 0, 'Conversaciones atendidas'),
    i.outsideHours != null ? stat(i.outsideHours, 'Fuera de horario') : stat(i.botReplies || 0, 'Respuestas del bot'),
    stat(i.hotLeads || 0, 'Leads calientes'),
    stat(i.captured || 0, 'Citas y pedidos captados'),
  ].join('');

  const leadsHtml = (p.leads || []).length
    ? `<tr><td style="padding:18px 28px 0;">
        <div style="font-size:12px;font-weight:700;color:${muted};text-transform:uppercase;letter-spacing:.04em;">Para llamar hoy</div>
        ${p.leads
          .map(
            (l) => `<div style="padding:10px 0;border-top:1px solid ${line};">
          <div style="color:${ink};font-size:14px;font-weight:600;">${escapeHtml(l.name || 'Cliente')}</div>
          ${l.reason ? `<div style="color:${muted};font-size:13px;margin-top:2px;">${escapeHtml(l.reason)}</div>` : ''}
        </div>`
          )
          .join('')}
        <a href="${base}/dashboard/conversaciones" style="color:${brand};font-size:13px;font-weight:600;text-decoration:none;">Ver en Conversaciones →</a>
      </td></tr>`
    : '';

  const learningHtml = (p.learning || []).length
    ? `<tr><td style="padding:18px 28px 0;">
        <div style="font-size:12px;font-weight:700;color:${muted};text-transform:uppercase;letter-spacing:.04em;">Tu bot aún no sabe responder</div>
        ${p.learning
          .map((s) => `<div style="padding:8px 0;border-top:1px solid ${line};color:${ink};font-size:14px;">“${escapeHtml(s.question)}”</div>`)
          .join('')}
        ${p.learningTotal > p.learning.length ? `<div style="color:${muted};font-size:12px;">Y ${p.learningTotal - p.learning.length} más.</div>` : ''}
        <a href="${base}/dashboard/entrenamiento#aprender" style="color:${brand};font-size:13px;font-weight:600;text-decoration:none;">Enseñárselo en un minuto →</a>
      </td></tr>`
    : '';

  const valueHtml =
    i.value?.total > 0
      ? `<tr><td style="padding:14px 28px 0;">
        <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;padding:14px 16px;color:#065f46;font-size:13px;line-height:1.6;">
          ≈ <b>${money(i.value.captured)}</b> en citas y pedidos captados y <b>${money(i.value.time)}</b> en tiempo ahorrado (~${i.hoursSaved} h).
          ${i.value.opportunities > 0 ? `<br>Además, <b>${money(i.value.opportunities)}</b> en oportunidades abiertas.` : ''}
          <div style="color:#047857;font-size:11px;margin-top:4px;">Estimado con tu ticket promedio y costo por hora.</div>
        </div></td></tr>`
      : !i.settings?.configured
        ? `<tr><td style="padding:14px 28px 0;color:${muted};font-size:13px;">Define tu <b>ticket promedio</b> en tu panel y este reporte te dirá cuánto dinero te genera tu bot. <a href="${base}/dashboard" style="color:${brand};">Configurarlo</a></td></tr>`
        : '';

  const html = `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${bg};font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${bg};padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#ffffff;border:1px solid ${line};border-radius:16px;overflow:hidden;">
        <tr><td style="padding:24px 28px 8px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="width:34px;height:34px;background:${brand};border-radius:9px;text-align:center;vertical-align:middle;color:#fff;font-weight:800;font-size:18px;">R</td>
            <td style="padding-left:10px;font-weight:800;font-size:18px;color:${ink};">RenBotIA</td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:8px 28px 0;">
          <div style="display:inline-block;background:#ecfdf5;color:#047857;font-size:12px;font-weight:700;padding:5px 10px;border-radius:999px;">Reporte semanal${p.businessName ? ` · ${escapeHtml(p.businessName)}` : ''}</div>
          <h1 style="margin:14px 0 4px;font-size:22px;line-height:1.3;color:${ink};">${escapeHtml(headline)}</h1>
          <p style="margin:0;color:${muted};font-size:14px;line-height:1.6;">${greet} esto hizo tu bot del lunes al domingo.</p>
        </td></tr>
        <tr><td style="padding:12px 22px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${line};border-radius:12px;"><tr>${stats}</tr></table>
        </td></tr>
        ${valueHtml}
        ${leadsHtml}
        ${learningHtml}
        <tr><td style="padding:22px 28px 24px;">
          <a href="${base}/dashboard" style="display:inline-block;background:${brand};color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 20px;border-radius:10px;">Ver mi panel</a>
        </td></tr>
        <tr><td style="padding:16px 28px 24px;border-top:1px solid ${line};">
          <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.6;">Recibes este reporte cada lunes. Puedes apagarlo en tu panel, en Inicio.<br>© ${new Date().getFullYear()} RenBotIA</p>
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
