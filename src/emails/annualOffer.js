/**
 * Oferta del plan anual a quien paga mensual (una sola vez, días 20–25 de su
 * mes pagado). Muestra el ahorro real, si aplica el precio de fundador y que el
 * año empieza al terminar su mes ya pagado.
 *
 * @param {object} p
 * @param {string} [p.name]
 * @param {string} p.planName
 * @param {number} p.monthlyMXN
 * @param {number} p.annualMXN
 * @param {number} p.perMonthMXN
 * @param {number} p.savingsMXN
 * @param {number} p.monthsPaid
 * @param {boolean} p.founder
 * @param {Date}   [p.founderUntil]
 * @param {Date}   [p.startsAt]     Cuando terminaría su mes actual (inicio del año).
 * @param {string} p.url            Enlace a Facturación.
 */
export function annualOfferEmail(p) {
  const first = String(p.name || '').trim().split(/\s+/)[0] || '';
  const money = (n) => `$${Number(n).toLocaleString('es-MX')}`;
  const day = (d) =>
    d ? new Date(d).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', timeZone: 'America/Mexico_City' }) : '';
  const lastFounderDay = p.founderUntil ? new Date(new Date(p.founderUntil).getTime() - 1) : null;
  const subject = `${first ? `${plain(first)}, ` : ''}ahorra ${money(p.savingsMXN)} al año con tu plan ${plain(p.planName)}`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#0F172A;max-width:520px">
  <p style="margin:0 0 12px">Hola${first ? ` ${esc(first)}` : ''},</p>
  <p style="margin:0 0 12px">Llevas casi un mes con tu plan <b>${esc(p.planName)}</b>. Si lo pagas por año, pagas <b>${p.monthsPaid} meses y recibes 12</b>:</p>
  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 14px;font-size:14px">
    <tr><td style="padding:8px 0;border-bottom:1px solid #E2E8F0;color:#64748B">Mensual</td><td style="padding:8px 0;border-bottom:1px solid #E2E8F0;text-align:right">${money(p.monthlyMXN)} al mes</td></tr>
    <tr><td style="padding:8px 0;border-bottom:1px solid #E2E8F0;color:#64748B">Anual</td><td style="padding:8px 0;border-bottom:1px solid #E2E8F0;text-align:right"><b>${money(p.annualMXN)}</b> al año (${money(p.perMonthMXN)} al mes)</td></tr>
    <tr><td style="padding:8px 0;color:#64748B">Ahorras</td><td style="padding:8px 0;text-align:right;color:#0A6B4F"><b>${money(p.savingsMXN)}</b> al año</td></tr>
  </table>
  ${
    p.founder && lastFounderDay
      ? `<p style="margin:0 0 12px">Es <b>precio de fundador</b>: válido hasta el ${day(lastFounderDay)} y lo conservas mientras sigas renovando en anual.</p>`
      : ''
  }
  <p style="margin:0 0 12px">No pierdes nada de lo que ya pagaste: tu año empieza${p.startsAt ? ` el ${day(p.startsAt)},` : ''} cuando termina tu mes actual. Tus créditos de IA se siguen renovando cada mes, y tienes <b>garantía de 30 días</b> con reembolso completo.</p>
  <a href="${esc(p.url)}" style="display:inline-block;background:#0A6B4F;color:#fff;text-decoration:none;font-weight:bold;padding:11px 18px;border-radius:8px">Pasar a anual</a>
  <p style="margin:24px 0 0;font-size:12px;color:#64748B">Equipo RenBotIA · Te lo enviamos una sola vez. Si prefieres seguir en mensual, no tienes que hacer nada.</p>
</div>`;
  return { subject, html };
}

function esc(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function plain(s = '') {
  return String(s).replace(/\s+/g, ' ').trim();
}
