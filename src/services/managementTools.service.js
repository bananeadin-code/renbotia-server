import { RECORD_TYPE_META } from '../config/constants.js';
import { getAvailableSlots, getAvailabilityRange } from './availability.service.js';
import { createRecord } from './management.service.js';
import { ManagedRecord } from '../models/ManagedRecord.js';
import { logger } from '../utils/logger.js';

/**
 * Herramientas (tool use) que el bot Elite puede llamar durante una conversación
 * para captar trabajo con criterio real de disponibilidad:
 *   - consultar_disponibilidad: ve qué espacios están libres.
 *   - agendar_trabajo: crea el registro (valida el espacio antes).
 *
 * Se exponen dinámicamente según los tipos habilitados en la config del negocio.
 */

const REASON_TEXT = {
  fecha_invalida: 'La fecha u hora no es válida.',
  en_el_pasado: 'Ese momento ya pasó.',
  anticipacion_insuficiente: 'Se requiere más anticipación para agendar.',
  fuera_de_horizonte: 'Esa fecha está demasiado lejos para agendar por ahora.',
  dia_no_disponible: 'Ese día el negocio no atiende.',
  horario_no_valido: 'Esa hora no coincide con un espacio disponible.',
  ocupado: 'Ese espacio ya está ocupado.',
};

/**
 * Construye las definiciones de herramientas para la API de Anthropic.
 * @param {object} config - ManagementConfig del negocio
 */
export function buildTools(config) {
  const enabled = (config.enabledTypes || []).filter((t) => RECORD_TYPE_META[t]);
  const scheduledTypes = enabled.filter((t) => RECORD_TYPE_META[t].scheduled);

  const tools = [];

  if (scheduledTypes.length) {
    tools.push({
      name: 'consultar_disponibilidad',
      description:
        'Consulta los espacios/horarios libres para agendar una cita o reservación en una fecha concreta. ' +
        'Úsala SIEMPRE antes de proponer o confirmar un horario, para no ofrecer espacios ocupados o fuera de horario.',
      input_schema: {
        type: 'object',
        properties: {
          fecha: {
            type: 'string',
            description: 'Fecha a consultar en formato YYYY-MM-DD (por ejemplo 2026-08-20).',
          },
        },
        required: ['fecha'],
      },
    });
  }

  tools.push({
    name: 'agendar_trabajo',
    description:
      'Registra el trabajo captado del cliente: ' +
      enabled.map((t) => RECORD_TYPE_META[t].label.toLowerCase()).join(', ') +
      '. Para citas y reservaciones DEBES incluir fecha y hora de un espacio que ya confirmaste libre. ' +
      'No inventes datos: si falta el nombre del cliente, pídelo antes de agendar.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: {
          type: 'string',
          enum: enabled,
          description: 'Tipo de trabajo a registrar.',
        },
        nombre_cliente: { type: 'string', description: 'Nombre de la persona.' },
        contacto: { type: 'string', description: 'Teléfono, WhatsApp o correo (opcional).' },
        fecha: {
          type: 'string',
          description: 'Solo citas/reservaciones: fecha en formato YYYY-MM-DD.',
        },
        hora: {
          type: 'string',
          description: 'Solo citas/reservaciones: hora en formato HH:mm (24h), ej. 15:00.',
        },
        personas: {
          type: 'integer',
          description: 'Nº de personas (reservaciones) o unidades relevantes. Por defecto 1.',
        },
        resumen: {
          type: 'string',
          description: 'Título breve (ej. "Consulta legal", "Mesa cena", "Pedido 2 pizzas").',
        },
        detalles: { type: 'string', description: 'Detalles adicionales relevantes (opcional).' },
      },
      required: ['tipo', 'nombre_cliente'],
    },
  });

  return tools;
}

function localDateFrom(fecha, hora) {
  const [y, mo, d] = String(fecha).split('-').map((x) => parseInt(x, 10));
  const { h, m } = (() => {
    const [hh, mm] = String(hora || '').split(':').map((x) => parseInt(x, 10));
    return { h: Number.isFinite(hh) ? hh : 0, m: Number.isFinite(mm) ? mm : 0 };
  })();
  if (![y, mo, d].every(Number.isFinite)) return null;
  return new Date(y, mo - 1, d, h, m, 0, 0);
}

const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * Busca un registro ACTIVO de la misma conversación que sería un duplicado del
 * que se intenta crear. Criterio:
 *  - Misma persona: coincide nombre o contacto (normalizados); si no hay nombre
 *    ni contacto, se considera la misma (un registro anónimo por conversación).
 *  - Agendables (cita/reservación): solo es duplicado si es el MISMO espacio
 *    (misma fecha/hora); otra hora es una cita nueva legítima.
 *  - No agendables (prospecto/pedido): un registro por persona/conversación.
 * @returns {Promise<object|null>} el registro duplicado o null.
 */
async function findDuplicate({ businessId, chatId, tipo, meta, data }) {
  const previos = await ManagedRecord.find({
    business: businessId,
    chat: chatId,
    type: tipo,
    status: { $ne: 'cancelado' },
  })
    .select('customer scheduledAt')
    .lean();

  const nameA = norm(data.customer?.name);
  const contactA = norm(data.customer?.contact);

  return (
    previos.find((r) => {
      const samePerson =
        (nameA && norm(r.customer?.name) === nameA) ||
        (contactA && norm(r.customer?.contact) === contactA) ||
        (!nameA && !contactA);
      if (!samePerson) return false;
      if (meta.scheduled) {
        const a = r.scheduledAt ? new Date(r.scheduledAt).getTime() : 0;
        const b = data.scheduledAt ? new Date(data.scheduledAt).getTime() : 0;
        return a === b;
      }
      return true;
    }) || null
  );
}

/**
 * Ejecuta una llamada de herramienta y devuelve un objeto de resultado que se
 * envía de vuelta a Claude como tool_result (stringificado).
 *
 * @returns {Promise<{ result: object, record?: object }>}
 */
export async function executeTool({ name, input, businessId, config, chatId }) {
  try {
    if (name === 'consultar_disponibilidad') {
      const fecha = input?.fecha;
      const slots = await getAvailableSlots(businessId, config, fecha);
      if (!slots.length) {
        // Ofrece alternativas cercanas para que el bot proponga otra fecha.
        const range = await getAvailabilityRange(businessId, config, 10);
        return {
          result: {
            fecha,
            disponible: false,
            mensaje: 'No hay espacios libres ese día.',
            proximas_fechas: range.slice(0, 5).map((r) => ({
              fecha: r.date,
              horas: r.slots.map((s) => s.time),
            })),
          },
        };
      }
      return {
        result: {
          fecha,
          disponible: true,
          horas_libres: slots.map((s) => s.time),
        },
      };
    }

    if (name === 'agendar_trabajo') {
      const tipo = input?.tipo;
      const meta = RECORD_TYPE_META[tipo];
      if (!meta) return { result: { ok: false, error: 'Tipo de trabajo no válido.' } };

      const data = {
        type: tipo,
        customer: { name: input?.nombre_cliente || '', contact: input?.contacto || '' },
        quantity: Number.isFinite(input?.personas) ? input.personas : 1,
        summary: input?.resumen || meta.label,
        notes: input?.detalles || '',
      };

      if (meta.scheduled) {
        const when = localDateFrom(input?.fecha, input?.hora);
        if (!when) {
          return { result: { ok: false, error: 'Falta la fecha u hora del espacio.' } };
        }
        data.scheduledAt = when;
      }

      // Red anti-duplicados: evita registrar dos veces a la misma persona en la
      // MISMA conversación (p. ej. si el bot interpreta un "gracias/igualmente"
      // como una solicitud nueva). Para agendables solo cuenta como duplicado el
      // MISMO espacio (otra hora sí es una cita legítima distinta); para
      // prospectos/pedidos, un registro por persona y conversación es suficiente.
      if (chatId) {
        const dup = await findDuplicate({ businessId, chatId, tipo, meta, data });
        if (dup) {
          logger.info(`agendar_trabajo: duplicado evitado (${tipo}) en chat ${chatId}`);
          return {
            result: {
              ok: true,
              duplicado: true,
              mensaje:
                `Este ${meta.label.toLowerCase()} ya estaba registrado en esta conversación; ` +
                'no se creó otro. Responde con normalidad y NO vuelvas a registrar.',
              tipo,
              id: String(dup._id),
            },
          };
        }
      }

      try {
        const record = await createRecord(businessId, data, { source: 'bot', chat: chatId });
        return {
          result: {
            ok: true,
            mensaje: `${meta.label} registrada correctamente.`,
            tipo,
            cuando: record.scheduledAt ? record.scheduledAt.toISOString() : null,
            id: record.id,
          },
          record,
        };
      } catch (err) {
        // Espacio no disponible u otra validación: se lo devolvemos al bot para
        // que ofrezca otra opción en lugar de fallar la conversación.
        const reason = err.details?.reason;
        return {
          result: {
            ok: false,
            error: reason ? REASON_TEXT[reason] || 'El horario no está disponible.' : (err.message || 'No se pudo registrar.'),
            motivo: reason || null,
          },
        };
      }
    }

    return { result: { ok: false, error: `Herramienta desconocida: ${name}` } };
  } catch (err) {
    logger.error(`executeTool(${name}) error: ${err.message}`);
    return { result: { ok: false, error: 'Ocurrió un error al procesar la solicitud.' } };
  }
}
