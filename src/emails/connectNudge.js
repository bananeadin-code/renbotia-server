/**
 * Ayuda a quien se registró y no ha conectado un canal (máximo 2 avisos):
 * ofrece la conexión asistida con el equipo o hacerlo por su cuenta.
 */
export function connectNudgeEmail({ name, step, bookingUrl, connectUrl, onboardingUrl, second }) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  const noBusiness = step === 'verificado';
  const subject = noBusiness
    ? `${first ? `${plain(first)}, ` : ''}tu bot está a un paso de quedar listo`
    : `${first ? `${plain(first)}, ` : ''}¿te ayudamos a conectar tu WhatsApp?`;
  const lead = noBusiness
    ? 'Creaste tu cuenta, pero falta configurar tu negocio para que tu bot pueda empezar a responder. Toma unos minutos.'
    : 'Tu bot ya está entrenado. Lo único que falta es conectarlo a tu WhatsApp para que empiece a atender a tus clientes.';
  const help = second
    ? 'Si te atoraste en algún paso, no te preocupes: es lo más común y lo resolvemos contigo en una llamada corta.'
    : 'Si prefieres, alguien del equipo te acompaña por videollamada y lo dejamos funcionando juntos, sin costo.';
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#0F172A;max-width:520px">
  <p style="margin:0 0 12px">Hola${first ? ` ${esc(first)}` : ''},</p>
  <p style="margin:0 0 12px">${lead}</p>
  <p style="margin:0 0 20px">${help}</p>
  <a href="${esc(bookingUrl)}" style="display:inline-block;background:#0A6B4F;color:#fff;text-decoration:none;font-weight:bold;padding:11px 18px;border-radius:8px">Agendar conexión asistida</a>
  <p style="margin:16px 0 0;font-size:14px"><a href="${esc(noBusiness ? onboardingUrl : connectUrl)}" style="color:#0E8A68">${noBusiness ? 'Terminar la configuración yo mismo' : 'Conectarlo yo mismo'}</a></p>
  <p style="margin:24px 0 0;font-size:12px;color:#64748B">Equipo RenBotIA · Es un aviso sobre tu cuenta; no te enviaremos más de dos.</p>
</div>`;
  return { subject, html };
}

function esc(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function plain(s = '') {
  return String(s).replace(/\s+/g, ' ').trim();
}
