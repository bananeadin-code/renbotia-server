/**
 * Reporte semanal del embudo (lunes): para el dueño y la agencia. Cumple la
 * "transparencia del embudo" del contrato sin preparar nada a mano.
 */
const money = (n) => (n == null ? '—' : `$${Math.round(n).toLocaleString('es-MX')}`);
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const cell = (v, right) =>
  `<td style="padding:6px 10px;border-bottom:1px solid #E2E8F0;${right ? 'text-align:right' : ''}">${esc(String(v))}</td>`;

function table(summary) {
  const t = summary.totals;
  const head = ['Canal', 'Registros', 'Negocio', 'Conectó', 'Pagó', 'Costo/registro', 'Costo/cliente'];
  const rows = summary.channels
    .map((c) =>
      `<tr>${[c.name, c.registrado, c.negocio, c.conectado, c.pago, money(c.costPerSignupMXN), money(c.cacMXN)]
        .map((v, i) => cell(v, i > 0))
        .join('')}</tr>`
    )
    .join('');
  const total = ['Total', t.registrado, t.negocio, t.conectado, t.pago, '', money(t.blendedCacMXN)].map((v, i) => cell(v, i > 0)).join('');
  return `<table style="border-collapse:collapse;font-size:13px;width:100%">
    <tr>${head.map((h, i) => `<th style="padding:6px 10px;border-bottom:2px solid #0F172A;text-align:${i ? 'right' : 'left'}">${h}</th>`).join('')}</tr>
    ${rows}
    <tr style="font-weight:bold">${total}</tr>
  </table>`;
}

function kpis(s) {
  const t = s.totals;
  return `<p style="font-size:14px;margin:8px 0 14px">Registro a pago: <b>${pct(t.pago, t.registrado)}</b> · Registro a canal conectado: <b>${pct(t.conectado, t.registrado)}</b> · Ingresos de estos registros: <b>${money(t.revenueMXN)}</b> · Inversión capturada: <b>${money(t.spendMXN)}</b></p>`;
}

export function funnelReportEmail({ week, month, url }) {
  const subject = `RenBotIA · Reporte semanal del embudo (${week.totals.registrado} registros, ${week.totals.pago} clientes)`;
  const html = `<div style="font-family:Arial,sans-serif;color:#0F172A;max-width:720px">
  <div style="font-size:12px;font-weight:bold;letter-spacing:.08em;color:#0E8A68;text-transform:uppercase">Reporte semanal</div>
  <h2 style="margin:6px 0 4px">Últimos 7 días</h2>${kpis(week)}${table(week)}
  <h2 style="margin:26px 0 4px">Mes en curso</h2>${kpis(month)}${table(month)}
  <p style="font-size:12px;color:#64748B;margin-top:16px">Costo por cliente = inversión del canal / registros de ese canal que ya pagaron. "Combinado" incluye pauta y agencia. Un registro puede pagar semanas después; los números del mes se ajustan solos.</p>
  <a href="${esc(url)}" style="display:inline-block;background:#0A6B4F;color:#fff;text-decoration:none;font-weight:bold;padding:10px 16px;border-radius:8px">Ver el embudo completo</a>
</div>`;
  return { subject, html };
}

function esc(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
