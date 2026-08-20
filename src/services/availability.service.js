import { ManagedRecord } from '../models/ManagedRecord.js';
import { ACTIVE_RECORD_STATUSES } from '../config/constants.js';

/**
 * Motor de disponibilidad de la agenda.
 *
 * Idea clave (lo que pidió el cliente): un espacio está "ocupado" solo si existe
 * un registro AGENDADO, ACTIVO (pendiente|confirmado) y con fecha FUTURA. Como
 * toda consulta filtra `scheduledAt >= ahora`, los registros cuya fecha ya pasó
 * dejan de contar por sí solos y el espacio vuelve a estar libre — sin cron ni
 * tareas programadas (mismo patrón "perezoso" del reseteo de tokens).
 *
 * Nota de zona horaria (MVP): las horas "HH:mm" del horario se interpretan en la
 * hora local del servidor. En despliegue real se usaría la timezone del negocio.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function pad(n) {
  return String(n).padStart(2, '0');
}

/** "YYYY-MM-DD" en hora local. */
export function dateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "HH:mm" en hora local. */
export function timeKey(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseHHMM(str) {
  const [h, m] = String(str || '').split(':').map((x) => parseInt(x, 10));
  return { h: Number.isFinite(h) ? h : 0, m: Number.isFinite(m) ? m : 0 };
}

/** Construye un Date local a partir de "YYYY-MM-DD" y minutos desde medianoche. */
function localDateAt(dateStr, minutes) {
  const [y, mo, d] = dateStr.split('-').map((x) => parseInt(x, 10));
  const date = new Date(y, mo - 1, d, 0, 0, 0, 0);
  date.setMinutes(minutes);
  return date;
}

function scheduleForDay(config, dateStr) {
  const [y, mo, d] = dateStr.split('-').map((x) => parseInt(x, 10));
  const weekday = new Date(y, mo - 1, d).getDay();
  return (config.schedule || []).find((s) => s.day === weekday) || null;
}

/**
 * Genera los inicios de espacio (Date) de un día según el horario, sin filtrar
 * por ocupación. Respeta apertura/cierre y la duración de cada espacio.
 */
function slotStartsForDay(config, dateStr) {
  const day = scheduleForDay(config, dateStr);
  if (!day || !day.enabled) return [];
  if ((config.blackoutDates || []).includes(dateStr)) return [];

  const open = parseHHMM(day.open);
  const close = parseHHMM(day.close);
  const openMin = open.h * 60 + open.m;
  const closeMin = close.h * 60 + close.m;
  const step = config.slotMinutes || 60;

  const starts = [];
  for (let m = openMin; m + step <= closeMin; m += step) {
    starts.push(localDateAt(dateStr, m));
  }
  return starts;
}

/**
 * Cuenta registros activos (ocupación) por inicio de espacio, para un negocio y
 * rango [from, to). Devuelve un Map ISO(slotStart) -> nº de registros activos.
 * Solo cuenta tipos agendables (cita/reservacion) que tienen scheduledAt.
 */
export async function getOccupancy(businessId, from, to) {
  const records = await ManagedRecord.find({
    business: businessId,
    status: { $in: ACTIVE_RECORD_STATUSES },
    scheduledAt: { $gte: from, $lt: to },
  }).select('scheduledAt');

  const map = new Map();
  for (const r of records) {
    if (!r.scheduledAt) continue;
    const key = r.scheduledAt.toISOString();
    map.set(key, (map.get(key) || 0) + 1);
  }
  return map;
}

/**
 * Espacios libres de un día concreto ("YYYY-MM-DD").
 * @returns {Promise<Array<{ iso, time, remaining }>>}
 */
export async function getAvailableSlots(businessId, config, dateStr) {
  const starts = slotStartsForDay(config, dateStr);
  if (!starts.length) return [];

  const now = new Date();
  const leadCutoff = new Date(now.getTime() + (config.leadTimeHours || 0) * 60 * 60 * 1000);
  const horizon = new Date(now.getTime() + (config.horizonDays || 30) * DAY_MS);

  // Ventana del día para leer ocupación de una sola vez.
  const dayStart = starts[0];
  const dayEnd = new Date(starts[starts.length - 1].getTime() + (config.slotMinutes || 60) * 60000);
  const occupancy = await getOccupancy(businessId, dayStart, dayEnd);

  const capacity = config.capacityPerSlot || 1;
  const slots = [];
  for (const start of starts) {
    if (start < leadCutoff) continue; // muy pronto (o ya pasó)
    if (start > horizon) continue; // fuera del horizonte
    const used = occupancy.get(start.toISOString()) || 0;
    const remaining = capacity - used;
    if (remaining > 0) {
      slots.push({ iso: start.toISOString(), time: timeKey(start), remaining });
    }
  }
  return slots;
}

/**
 * Disponibilidad de varios días a partir de hoy (para la agenda del panel y para
 * que el bot ofrezca opciones). Devuelve solo días con al menos un espacio libre.
 */
export async function getAvailabilityRange(businessId, config, days = 7) {
  const out = [];
  const base = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(base.getTime() + i * DAY_MS);
    const key = dateKey(d);
    const slots = await getAvailableSlots(businessId, config, key);
    if (slots.length) out.push({ date: key, slots });
  }
  return out;
}

/**
 * Valida si un momento concreto se puede agendar. Devuelve un resultado
 * uniforme { ok, reason, iso } para que el bot y el alta manual reaccionen igual.
 */
export async function checkSlot(businessId, config, whenDate) {
  const when = whenDate instanceof Date ? whenDate : new Date(whenDate);
  if (Number.isNaN(when.getTime())) {
    return { ok: false, reason: 'fecha_invalida' };
  }

  const now = new Date();
  const leadCutoff = new Date(now.getTime() + (config.leadTimeHours || 0) * 60 * 60 * 1000);
  const horizon = new Date(now.getTime() + (config.horizonDays || 30) * DAY_MS);

  if (when < now) return { ok: false, reason: 'en_el_pasado' };
  if (when < leadCutoff) return { ok: false, reason: 'anticipacion_insuficiente' };
  if (when > horizon) return { ok: false, reason: 'fuera_de_horizonte' };

  const dateStr = dateKey(when);
  const starts = slotStartsForDay(config, dateStr);
  if (!starts.length) return { ok: false, reason: 'dia_no_disponible' };

  // Debe coincidir con el inicio de un espacio válido.
  const match = starts.find((s) => s.getTime() === when.getTime());
  if (!match) return { ok: false, reason: 'horario_no_valido' };

  const capacity = config.capacityPerSlot || 1;
  const occupancy = await getOccupancy(
    businessId,
    match,
    new Date(match.getTime() + (config.slotMinutes || 60) * 60000)
  );
  const used = occupancy.get(match.toISOString()) || 0;
  if (used >= capacity) return { ok: false, reason: 'ocupado' };

  return { ok: true, iso: match.toISOString(), remaining: capacity - used };
}
