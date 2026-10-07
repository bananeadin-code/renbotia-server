/**
 * Avisos de la renovación con cobro del plan:
 *  - upcoming:          "tu plan se renueva el X por $Y con tu Visa •••• 4242".
 *  - upcoming_no_card:  igual, pero sin tarjeta guardada: pide agregarla.
 *  - failed:            el cobro falló; hay N días de gracia para resolverlo.
 *  - downgraded:        terminó la gracia sin pago y la cuenta bajó a Free.
 *
 * @param {object} p
 * @param {'upcoming'|'upcoming_no_card'|'failed'|'downgraded'} p.kind
 * @param {string} [p.customerName]
 * @param {string} [p.businessName]
 * @param {string} [p.planName]
 * @param {number} [p.amountMXN]
 * @param {{brand:string,last4:string}|null} [p.card]
 * @param {Date}   [p.date]       Fecha de renovación (upcoming).
 * @param {Date}   [p.graceEnds]  Fin de la gracia (failed).
 * @param {string} [p.reason]     Motivo del fallo (failed).
 * @param {string} p.url          Enlace a Facturación.
 * @returns {{ subject: string, html: string }}
 */
export function renewalEmail(p) {
  const brand = '#0f9d6e';
  const ink = '#0f172a';
  const muted = '#64748b';
  const line = '#e2e8f0';
  const bg = '#f1f5f9';

  const plan = escapeHtml(p.planName || 'de pago');
  const money = p.amountMXN != null ? `$${Number(p.amountMXN).toLocaleString('es-MX')} MXN` : '';
  const card = p.card?.last4 ? `${capitalize(p.card.brand)} terminación ${escapeHtml(p.card.last4)}` : '';
  const fmt = (d) =>
    d ? new Date(d).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', timeZone: 'America/Mexico_City' }) : '';
  const greetName = p.customerName ? `Hola ${escapeHtml(p.customerName)},` : 'Hola,';
  const biz = p.businessName ? ` de <b>${escapeHtml(p.businessName)}</b>` : '';

  const reasonText = {
    no_card: 'no hay una tarjeta guardada en tu cuenta',
    card_declined: 'el banco rechazó el cargo',
    insufficient_funds: 'la tarjeta no tiene fondos suficientes',
    expired_card: 'la tarjeta está vencida',
    authentication_required: 'tu banco pide confirmar el pago',
  }[p.reason] || 'no pudimos completar el cargo';

  const variants = {
    upcoming: {
      tag: ['Renovación', '#ecfdf5', '#047857'],
      subject: `Tu plan ${p.planName || ''} se renueva el ${fmt(p.date)}`.replace(/\s+/g, ' '),
      title: `Tu plan ${plan} se renueva pronto`,
      body: `${greetName} el ${fmt(p.date)} renovaremos el plan ${plan}${biz} por <b>${money}</b>${
        card ? ` con tu ${card}` : ''
      }. No tienes que hacer nada. Si prefieres cambiar de plan o cancelar, puedes hacerlo antes desde Facturación.`,
      cta: 'Ver mi plan',
    },
    upcoming_no_card: {
      tag: ['Acción necesaria', '#fff7ed', '#b45309'],
      subject: `Agrega una tarjeta para renovar tu plan ${p.planName || ''}`.replace(/\s+/g, ' '),
      title: 'Agrega una tarjeta para conservar tu plan',
      body: `${greetName} el ${fmt(p.date)} se renueva el plan ${plan}${biz} por <b>${money}</b>, pero aún no tienes una tarjeta guardada. Agrégala desde Facturación para que tu bot siga con todas sus funciones. Si no se puede cobrar, tu cuenta pasará al plan Free.`,
      cta: 'Agregar tarjeta',
    },
    failed: {
      tag: ['Pago pendiente', '#fef2f2', '#b91c1c'],
      subject: `No pudimos renovar tu plan ${p.planName || ''}`.replace(/\s+/g, ' '),
      title: 'No pudimos cobrar la renovación',
      body: `${greetName} intentamos renovar el plan ${plan}${biz} por <b>${money}</b>, pero ${reasonText}. Tu bot sigue funcionando con lo que le quedaba del mes. Tienes hasta el <b>${fmt(
        p.graceEnds
      )}</b> para actualizar tu tarjeta o pagar desde Facturación; volveremos a intentarlo automáticamente. Después de esa fecha tu cuenta pasará al plan Free.`,
      cta: 'Resolver el pago',
    },
    downgraded: {
      tag: ['Plan Free', '#f1f5f9', '#334155'],
      subject: 'Tu cuenta pasó al plan Free',
      title: 'Tu cuenta pasó al plan Free',
      body: `${greetName} no pudimos cobrar la renovación del plan ${plan}${biz}, así que tu cuenta pasó al plan Free. Tu bot, tu entrenamiento y tus créditos comprados se conservan. Puedes volver a tu plan cuando quieras desde Facturación.`,
      cta: 'Volver a mi plan',
    },
  };
  const v = variants[p.kind] || variants.upcoming;

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
          <div style="display:inline-block;background:${v.tag[1]};color:${v.tag[2]};font-size:12px;font-weight:700;padding:5px 10px;border-radius:999px;">${v.tag[0]}</div>
          <h1 style="margin:14px 0 4px;font-size:22px;color:${ink};">${v.title}</h1>
          <p style="margin:0 0 4px;color:${muted};font-size:14px;line-height:1.6;">${v.body}</p>
        </td></tr>
        <tr><td style="padding:18px 28px 24px;">
          <a href="${p.url}" style="display:inline-block;background:${brand};color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 20px;border-radius:10px;">${v.cta}</a>
        </td></tr>
        <tr><td style="padding:16px 28px 24px;border-top:1px solid ${line};">
          <p style="margin:0;color:#94a3b8;font-size:12px;">© ${new Date().getFullYear()} RenBotIA · Asistentes de WhatsApp con IA</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject: v.subject, html };
}

function capitalize(s = '') {
  const t = escapeHtml(s);
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
