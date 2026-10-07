/**
 * ¿Debe contestar el bot ahora mismo? Reúne dos ajustes del negocio:
 *
 * - Pausa por canal (Business.channelSettings[canal].paused): el canal sigue
 *   conectado y los mensajes llegan a la bandeja, pero el bot no contesta.
 * - Horario de atención (BotConfig.schedule): con botMode 'closed_only' el bot
 *   solo contesta FUERA del horario (dentro, atiende una persona); con 'always'
 *   contesta siempre y, si está cerrado, se le avisa para que lo comunique.
 *
 * El simulador nunca se pausa (es para probar el bot).
 */

export const SCHEDULE_TIMEZONES = [
  'America/Mexico_City',
  'America/Tijuana',
  'America/Hermosillo',
  'America/Mazatlan',
  'America/Cancun',
  'America/Bogota',
  'America/Lima',
  'America/Santiago',
  'America/Argentina/Buenos_Aires',
  'America/Guatemala',
  'Europe/Madrid',
];

const DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const toMinutes = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Día (0=domingo) y minuto del día en la zona horaria del negocio. */
function localNow(timezone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'America/Mexico_City',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { day: DAY_INDEX[get('weekday')], minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

/**
 * ¿El negocio está abierto según su horario? Admite horarios que cruzan la
 * medianoche (p. ej. 18:00–02:00). null si el horario no está configurado.
 */
export function isOpenNow(schedule, now = new Date()) {
  if (!schedule?.enabled || !Array.isArray(schedule.days)) return null;
  const { day, minutes } = localNow(schedule.timezone, now);
  const fits = (d, m) => {
    const slot = schedule.days.find((s) => s.day === d && s.enabled);
    if (!slot) return { inToday: false, overnightTail: false };
    const open = toMinutes(slot.open);
    const close = toMinutes(slot.close);
    if (open == null || close == null) return { inToday: false, overnightTail: false };
    if (open < close) return { inToday: m >= open && m < close, overnightTail: false };
    // Cruza la medianoche: abierto desde `open` hasta fin del día…
    return { inToday: m >= open, overnightTail: true, close };
  };
  if (fits(day, minutes).inToday) return true;
  // …y la madrugada siguiente hasta `close` (cuenta para el día anterior).
  const prev = fits((day + 6) % 7, minutes);
  return Boolean(prev.overnightTail && minutes < prev.close);
}

/** Texto legible del horario, para que el bot lo comunique. */
export function describeSchedule(schedule) {
  const days = (schedule?.days || []).filter((d) => d.enabled).sort((a, b) => a.day - b.day);
  if (!days.length) return '';
  return days.map((d) => `${DAY_NAMES[d.day]} ${d.open}–${d.close}`).join(', ');
}

/** ¿El canal está en pausa ahora? Una pausa con fecha (pausedUntil) vence sola. */
export function isChannelPaused(business, channel, now = new Date()) {
  const cs = business?.channelSettings?.[channel];
  if (!cs?.paused) return false;
  return !cs.pausedUntil || new Date(cs.pausedUntil) > now;
}

/**
 * Decide qué hace el bot con un mensaje entrante.
 * @returns {{ reply: boolean, reason?: 'channel_paused'|'business_hours', closed: boolean }}
 */
export function botAvailability({ business, schedule, channel, source }) {
  if (source === 'simulator') return { reply: true, closed: false };
  if (isChannelPaused(business, channel)) return { reply: false, reason: 'channel_paused', closed: false };
  const open = isOpenNow(schedule);
  if (open === null) return { reply: true, closed: false };
  if (schedule.botMode === 'closed_only' && open) return { reply: false, reason: 'business_hours', closed: false };
  return { reply: true, closed: !open };
}
