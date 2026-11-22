import { env } from '../config/env.js';

/**
 * Email "tienes clientes esperando": leads calientes o casos que el bot pasó a
 * una persona y que nadie ha atendido (no se ha respondido ni marcado atendido).
 * Lo manda leadFollowUp.service: un recordatorio a las ~2 h y un resumen diario.
 *
 * @param {object} p
 * @param {string} [p.customerName]  nombre del dueño (saludo)
 * @param {string} [p.businessName]
 * @param {boolean} [p.digest]       true = resumen diario (casos de más de un día)
 * @param {Array<{ name: string, kind: 'lead'|'attention', reason: string, waitingHours: number }>} p.items
 * @param {number} [p.more]          cuántos más hay fuera de la lista
 * @returns {{ subject: string, html: string }}
 */
export function pendingLeadsEmail(p) {
  const brand = '#0f9d6e';
  const ink = '#0f172a';
  const muted = '#64748b';
  const line = '#e2e8f0';
  const bg = '#f1f5f9';

  const items = p.items || [];
  const total = items.length + (p.more || 0);
  const greetName = p.customerName ? `Hola ${escapeHtml(p.customerName)},` : 'Hola,';
  const convUrl = `${env.publicUrl.replace(/\/$/, '')}/dashboard/conversaciones`;
  const people = total === 1 ? '1 cliente espera' : `${total} clientes esperan`;
  const subject = `${people} respuesta${p.businessName ? ` — ${plain(p.businessName)}` : ''}`;
  const intro = p.digest
    ? `${greetName} estos clientes siguen sin respuesta de tu equipo desde ayer o antes. Entre más esperan, más fácil es que se vayan con otro negocio.`
    : `${greetName} el bot pasó estos casos a tu equipo y todavía nadie los ha atendido. Una respuesta rápida es lo que más ayuda a cerrar.`;

  const rows = items
    .map((it) => {
      const tag =
        it.kind === 'lead'
          ? '<span style="background:#ecfdf5;color:#047857;font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px;">Lead caliente</span>'
          : '<span style="background:#fffbeb;color:#b45309;font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px;">Requiere atención</span>';
      return `<tr><td style="padding:12px 0;border-top:1px solid ${line};">
        <div>${tag} <span style="color:${muted};font-size:12px;">· esperando ${escapeHtml(waitingLabel(it.waitingHours))}</span></div>
        <div style="color:${ink};font-size:14px;font-weight:600;margin-top:6px;">${escapeHtml(it.name || 'Cliente')}</div>
        ${it.reason ? `<div style="color:${muted};font-size:13px;margin-top:2px;">${escapeHtml(it.reason)}</div>` : ''}
      </td></tr>`;
    })
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
          <h1 style="margin:10px 0 6px;font-size:22px;color:${ink};">${escapeHtml(people)} respuesta</h1>
          <p style="margin:0;color:${muted};font-size:14px;line-height:1.6;">${intro}</p>
        </td></tr>
        <tr><td style="padding:12px 28px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
          ${p.more ? `<p style="margin:8px 0 0;color:${muted};font-size:13px;">Y ${p.more} más en tu bandeja.</p>` : ''}
        </td></tr>
        <tr><td style="padding:18px 28px 24px;">
          <a href="${convUrl}" style="display:inline-block;background:${brand};color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 20px;border-radius:10px;">Atender en Conversaciones</a>
          <p style="margin:14px 0 0;color:${muted};font-size:12px;line-height:1.6;">Cuando respondas a un cliente o lo marques como <b>atendido</b>, deja de aparecer aquí. Si el bot no supo algo, enséñaselo en <b>Entrenamiento</b> para que la próxima vez responda solo.</p>
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

function waitingLabel(hours) {
  if (hours < 1) return 'menos de 1 hora';
  if (hours < 24) return `${Math.floor(hours)} h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 día' : `${days} días`;
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Texto de asunto: los asuntos no son HTML (sin &amp;), y en una sola línea. */
function plain(str = '') {
  return String(str).replace(/\s+/g, ' ').trim();
}
