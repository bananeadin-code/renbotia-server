/**
 * Llena las ANALÍTICAS de cuentas demo (p. ej. las de Dinametra) con actividad
 * de ejemplo, para que el panel muestre datos al grabar anuncios: tendencia de
 * 6 meses, canales, trabajo captado (citas, pedidos, prospectos…), leads
 * calientes, etiquetas, tiempo de respuesta y "Lo que generó tu bot".
 *
 * Qué crea, por cada negocio del dueño:
 *   - Conversaciones en WhatsApp, Instagram, Messenger y Sitio web (6 meses,
 *     con crecimiento mes a mes), con mensajes del cliente, respuestas del bot,
 *     algunas respuestas de una persona del equipo y seguimientos.
 *   - Registros de trabajo captado según los tipos que el negocio tiene activos
 *     en Gestión (si no hay, usa citas y prospectos).
 *   - Ticket promedio de ejemplo (solo si el negocio no tiene uno), para que el
 *     resumen en pesos no salga en cero.
 *
 * Seguro de repetir: antes de crear, borra SOLO lo que este script creó antes
 * (marcado como demo), así que nunca duplica ni toca datos reales. No envía
 * mensajes a nadie: las conversaciones no llevan teléfono real.
 *
 * IMPORTANTE: las conversaciones sin actividad se borran solas a los 30 días
 * (retención). Aquí la última actividad queda en los últimos 12 días, así que
 * los datos duran al menos ~18 días. Antes de grabar, vuelve a correrlo.
 *
 * Uso (en el Shell de Render, donde ya está MONGODB_URI):
 *   node scripts/seed-demo-analytics.mjs correo1@dominio.com correo2@dominio.com
 *
 * Opciones:
 *   --volumen=N   conversaciones del mes más alto (por defecto 140, de 20 a 600)
 *   --borrar      solo quita los datos demo (no crea nada)
 */
import mongoose from 'mongoose';
import { User } from '../src/models/User.js';
import { Business } from '../src/models/Business.js';
import { BotConfig } from '../src/models/BotConfig.js';
import { ManagementConfig } from '../src/models/ManagementConfig.js';
import { ChatSimulation } from '../src/models/ChatSimulation.js';
import { ManagedRecord } from '../src/models/ManagedRecord.js';

const DEMO_PREFIX = 'demo-analiticas-';

const args = process.argv.slice(2);
const onlyDelete = args.includes('--borrar');
const volArg = args.find((a) => a.startsWith('--volumen='));
const volume = volArg ? Number(volArg.split('=')[1]) : 140;
const emails = args.filter((a) => !a.startsWith('--')).map((e) => e.trim().toLowerCase());
const MONGODB_URI = process.env.MONGODB_URI;

function fail(msg) {
  console.error(`\nError: ${msg}\n`);
  process.exit(1);
}

if (!MONGODB_URI) fail('Falta MONGODB_URI en el entorno.');
if (!emails.length) fail('Uso: node scripts/seed-demo-analytics.mjs correo@dominio.com [otro@dominio.com] [--volumen=140] [--borrar]');
if (!Number.isInteger(volume) || volume < 20 || volume > 600) fail('--volumen debe ser un número entre 20 y 600.');

// ── Azar reproducible por negocio (mismo negocio → mismos datos) ──
function rng(seedText) {
  let h = 1779033703 ^ seedText.length;
  for (let i = 0; i < seedText.length; i++) {
    h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const FIRST = ['Ana', 'Luis', 'María', 'Jorge', 'Sofía', 'Carlos', 'Valeria', 'Miguel', 'Fernanda', 'Diego', 'Daniela', 'Ricardo', 'Paola', 'Andrés', 'Mariana', 'Héctor', 'Lucía', 'Roberto', 'Camila', 'Alejandro', 'Gabriela', 'Fernando', 'Regina', 'Iván', 'Ximena', 'Óscar', 'Natalia', 'Emilio', 'Renata', 'Pablo'];
const LAST = ['G.', 'M.', 'R.', 'L.', 'H.', 'S.', 'P.', 'T.', 'C.', 'V.', 'D.', 'A.'];
const TAGS = ['nuevo cliente', 'cotización', 'seguimiento', 'venta', 'soporte', 'recurrente'];
const CHANNELS = [
  ['whatsapp', 0.58],
  ['instagram', 0.18],
  ['facebook', 0.12],
  ['web', 0.12],
];

// Conversaciones por sector: [mensaje del cliente, respuesta del bot]. {s} = un servicio del negocio.
const OPENERS = {
  legal: [
    ['Hola, buenas tardes. Necesito asesoría sobre {s}, ¿me pueden ayudar?', '¡Hola! Claro que sí. Con gusto te orientamos sobre {s}. ¿Me cuentas brevemente tu caso para darte la mejor opción?'],
    ['¿Cuánto cuesta una consulta?', 'La consulta inicial tiene un costo accesible y en ella revisamos tu caso a detalle. ¿Te gustaría agendar una?'],
    ['Me llegó un citatorio y no sé qué hacer', 'Entiendo, no te preocupes. Lo mejor es revisarlo con uno de nuestros abogados cuanto antes. ¿Te agendo una cita esta semana?'],
  ],
  contable: [
    ['Hola, necesito ayuda con {s}', '¡Hola! Con gusto te ayudamos con {s}. ¿Eres persona física o moral?'],
    ['¿Me pueden ayudar con mi declaración anual?', '¡Claro! Hacemos tu declaración y revisamos si tienes saldo a favor. ¿Agendamos una llamada para ver tus datos?'],
    ['¿Cuánto cobran por llevar la contabilidad mensual?', 'Depende del régimen y del número de facturas al mes. ¿Me compartes tu régimen para darte una cotización?'],
  ],
  consultoria: [
    ['Hola, me interesa {s} para mi empresa', '¡Hola! Qué gusto. Para recomendarte la mejor forma de trabajar {s}, ¿de qué tamaño es tu equipo?'],
    ['¿Tienen algún diagnóstico inicial?', 'Sí, hacemos un diagnóstico inicial para entender tu situación y proponerte un plan. ¿Te agendo una sesión?'],
  ],
  agencia: [
    ['Hola, quiero cotizar {s}', '¡Hola! Con gusto. Para darte una cotización precisa de {s}, ¿cuál es el objetivo principal de tu marca?'],
    ['¿Manejan redes sociales para negocios locales?', '¡Sí! Trabajamos con negocios locales de distintos giros. ¿Me compartes tu negocio y en qué redes estás?'],
    ['¿Cuánto cuesta una campaña de anuncios?', 'Depende del alcance y la duración. Te armamos una propuesta a la medida. ¿Agendamos una llamada de 15 minutos?'],
  ],
  otro: [
    ['Hola, ¿tienen disponible {s}?', '¡Hola! Sí, tenemos {s} disponible. ¿Te comparto precios y opciones?'],
    ['¿Cuál es su horario?', 'Atendemos de lunes a sábado. Si quieres, te ayudo a apartar tu lugar o tu pedido desde aquí mismo.'],
    ['Quiero hacer un pedido', '¡Perfecto! Dime qué te gustaría y para cuándo lo necesitas, y te lo dejo listo.'],
    ['¿Hacen envíos o entregas?', 'Sí, hacemos entregas en la zona. ¿Me compartes tu colonia para confirmarte el tiempo?'],
  ],
};
const FOLLOW_UPS = [
  ['Perfecto, ¿qué días tienen disponibles?', 'Tenemos espacio el jueves por la tarde y el viernes por la mañana. ¿Cuál te acomoda mejor?'],
  ['Va, el jueves me queda bien', '¡Listo! Te dejé agendado. Te enviaremos un recordatorio un día antes.'],
  ['¿Aceptan tarjeta?', 'Sí, aceptamos tarjeta, transferencia y efectivo.'],
  ['¿Dónde están ubicados?', 'Te comparto la ubicación. También puedes escribirnos por aquí si necesitas indicaciones.'],
  ['Gracias, muy amables', '¡Con gusto! Aquí estamos para lo que necesites.'],
];
const RETURNS = [
  ['Hola de nuevo, quería confirmar lo que platicamos', '¡Hola otra vez! Claro, aquí sigue todo como lo dejamos. ¿Te ayudo con algo más?'],
  ['Buen día, ¿siguen con la misma promoción?', '¡Buen día! Sí, sigue vigente esta semana. ¿Quieres que te aparte un lugar?'],
];
const AGENT_LINES = ['Hola, soy del equipo. Ya revisé tu caso y te confirmo que sí podemos ayudarte.', 'Te escribo para darte seguimiento personal. ¿Te parece bien una llamada mañana?'];
const FOLLOW_UP_MSG = 'Hola, ¿pudiste revisar la información que te compartimos? Si tienes alguna duda, aquí estamos.';
const HOT_REASONS = ['Quiere contratar esta semana', 'Pidió cotización y fecha de inicio', 'Preguntó por formas de pago para cerrar'];
const SUMMARIES = {
  cita: ['Cita de valoración', 'Consulta inicial', 'Llamada de seguimiento', 'Reunión de diagnóstico'],
  reservacion: ['Reservación para 2', 'Mesa para 4', 'Reservación de grupo'],
  pedido: ['Pedido a domicilio', 'Pedido para recoger', 'Pedido especial'],
  prospecto: ['Interesado en cotización', 'Pidió información de precios', 'Quiere propuesta formal'],
};
const TICKETS = { legal: 1500, contable: 1200, consultoria: 3500, agencia: 4500, otro: 450 };

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
// Hora local de México (UTC-6) a partir de un día y hora/minuto locales.
function atLocal(day, hour, minute) {
  const d = new Date(day);
  d.setUTCHours(hour + 6, minute, 0, 0);
  return d;
}

async function wipeDemo(businessIds) {
  const [c, r] = await Promise.all([
    ChatSimulation.deleteMany({ business: { $in: businessIds }, customerId: { $regex: `^${DEMO_PREFIX}` } }),
    ManagedRecord.deleteMany({ business: { $in: businessIds }, 'details.demoSeed': true }),
  ]);
  return { chats: c.deletedCount, records: r.deletedCount };
}

async function seedBusiness(business, now) {
  const rand = rng(String(business._id));
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const chance = (p) => rand() < p;

  const [botConfig, mgmt] = await Promise.all([
    BotConfig.findOne({ business: business._id }).select('businessInfo.services').lean(),
    ManagementConfig.findOne({ business: business._id }).select('enabledTypes').lean(),
  ]);
  const services = (botConfig?.businessInfo?.services || []).filter(Boolean);
  const service = () => (services.length ? pick(services) : 'sus servicios');
  const openers = OPENERS[business.industry] || OPENERS.otro;
  let types = (mgmt?.enabledTypes || []).filter((t) => SUMMARIES[t]);
  if (!types.length) types = ['cita', 'prospecto'];
  if (!types.includes('prospecto')) types.push('prospecto');

  const pickChannel = () => {
    let x = rand();
    for (const [ch, p] of CHANNELS) if ((x -= p) <= 0) return ch;
    return 'whatsapp';
  };

  // Crecimiento de 6 meses (el actual, proporcional a los días que van).
  const SHAPE = [0.34, 0.47, 0.6, 0.74, 0.88, 1];
  const chats = [];
  const records = [];
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthFraction = (now - startOfMonth) / (new Date(now.getFullYear(), now.getMonth() + 1, 1) - startOfMonth);

  for (let i = 5; i >= 0; i--) {
    const mStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const mEnd = i === 0 ? now : new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const target = Math.round(volume * SHAPE[5 - i] * (i === 0 ? monthFraction : 1) * (0.96 + rand() * 0.08));

    for (let k = 0; k < target; k++) {
      const day = new Date(mStart.getTime() + rand() * (mEnd - mStart));
      // ~25 % escribe fuera de horario (noche), el resto en horario de oficina.
      const hour = chance(0.25) ? 20 + Math.floor(rand() * 3) : 9 + Math.floor(rand() * 10);
      let t = atLocal(day, hour, Math.floor(rand() * 60));
      if (t > now) t = new Date(now.getTime() - (5 + rand() * 120) * MIN);
      const createdAt = t;

      const channel = pickChannel();
      const name = `${pick(FIRST)} ${pick(LAST)}`;
      const messages = [];
      const say = (role, content, extra = {}) => messages.push({ role, content, tokens: 0, via: 'bot', timestamp: new Date(t), ...extra });
      // El bot contesta en segundos (5 a 50 s).
      const botDelay = () => (t = new Date(t.getTime() + (5 + rand() * 45) * 1000));
      const clientDelay = () => (t = new Date(t.getTime() + (1 + rand() * 9) * MIN));

      const [q, a] = pick(openers);
      const s = service();
      say('user', q.replace('{s}', s));
      botDelay();
      say('assistant', a.replace('{s}', s));
      const extra = Math.floor(rand() * 3);
      const used = new Set();
      for (let e = 0; e < extra; e++) {
        const idx = Math.floor(rand() * FOLLOW_UPS.length);
        if (used.has(idx)) continue;
        used.add(idx);
        clientDelay();
        say('user', FOLLOW_UPS[idx][0]);
        botDelay();
        say('assistant', FOLLOW_UPS[idx][1]);
      }
      if (chance(0.12)) {
        t = new Date(t.getTime() + (10 + rand() * 50) * MIN);
        say('assistant', pick(AGENT_LINES), { via: 'agent' });
      }

      // Retención de 30 días: la última actividad debe ser reciente. Las
      // conversaciones viejas reciben un regreso del cliente en los últimos 12 días.
      const recentFloor = new Date(now.getTime() - 12 * DAY);
      if (t < recentFloor) {
        t = new Date(recentFloor.getTime() + rand() * (now - recentFloor - 2 * 60 * MIN));
        const [rq, ra] = pick(RETURNS);
        say('user', rq);
        botDelay();
        say('assistant', ra);
      }
      // Seguimiento automático en algunas (el cliente dejó de responder).
      if (chance(0.05) && t.getTime() + DAY < now.getTime()) {
        t = new Date(t.getTime() + (20 + rand() * 4) * 60 * MIN);
        say('assistant', FOLLOW_UP_MSG, { followUp: true });
      }
      if (t > now) t = new Date(now.getTime() - 60 * 1000);
      for (const m of messages) if (m.timestamp > now) m.timestamp = new Date(now.getTime() - 60 * 1000);

      const recent = now - createdAt < 30 * DAY;
      const hot = recent && chance(0.11);
      const chat = {
        _id: new mongoose.Types.ObjectId(),
        business: business._id,
        title: name,
        channel,
        customerPhone: '',
        customerId: `${DEMO_PREFIX}${new mongoose.Types.ObjectId()}`,
        customerName: name,
        startedBy: null,
        customerContact: channel === 'web' && chance(0.6) ? `${name.split(' ')[0].toLowerCase()}.demo@ejemplo.com` : '',
        messages,
        handoffMode: messages.some((m) => m.via === 'agent') ? 'manual' : 'bot',
        needsAttention: recent && chance(0.04),
        attentionReason: '',
        capturedRecordType: '',
        tags: chance(0.55) ? [...new Set([pick(TAGS), ...(chance(0.3) ? [pick(TAGS)] : [])])] : [],
        hotLead: hot,
        hotLeadReason: hot ? pick(HOT_REASONS) : '',
        hotLeadAt: hot ? new Date(createdAt.getTime() + 2 * MIN) : null,
        followUpAt: null,
        templateFollowUpAt: null,
        webLastSeenAt: null,
        webReplyEmailAt: null,
        webOrigin: '',
        createdAt,
        updatedAt: t,
        __v: 0,
      };

      // ~24 % de las conversaciones termina en trabajo captado por el bot.
      if (chance(0.24)) {
        const type = pick(types);
        const recAt = new Date(createdAt.getTime() + (3 + rand() * 20) * MIN);
        const scheduled = type === 'cita' || type === 'reservacion';
        const scheduledAt = scheduled ? atLocal(new Date(recAt.getTime() + (1 + Math.floor(rand() * 7)) * DAY), 10 + Math.floor(rand() * 8), chance(0.5) ? 0 : 30) : null;
        const past = scheduledAt ? scheduledAt < now : now - recAt > 3 * DAY;
        const status = chance(0.06) ? 'cancelado' : past ? (chance(0.8) ? 'completado' : 'confirmado') : chance(0.6) ? 'confirmado' : 'pendiente';
        chat.capturedRecordType = type;
        records.push({
          business: business._id,
          type,
          status,
          customer: { name, contact: chat.customerContact },
          scheduledAt,
          quantity: type === 'reservacion' ? 2 + Math.floor(rand() * 4) : 1,
          summary: pick(SUMMARIES[type]),
          notes: '',
          details: { demoSeed: true },
          source: 'bot',
          chat: chat._id,
          channel,
          reminder: { status: '', sentAt: null, via: '', answeredAt: null, note: '' },
          createdAt: recAt,
          updatedAt: recAt,
          __v: 0,
        });
      }
      chats.push(chat);
    }
  }

  // Algunos registros dados de alta a mano por el equipo (~5 %).
  const manual = Math.round(records.length * 0.05);
  for (let k = 0; k < manual; k++) {
    const at = new Date(now.getTime() - rand() * 150 * DAY);
    const type = pick(types);
    records.push({
      business: business._id,
      type,
      status: 'completado',
      customer: { name: `${pick(FIRST)} ${pick(LAST)}`, contact: '' },
      scheduledAt: type === 'cita' || type === 'reservacion' ? at : null,
      quantity: 1,
      summary: pick(SUMMARIES[type]),
      notes: '',
      details: { demoSeed: true },
      source: 'manual',
      chat: null,
      channel: null,
      reminder: { status: '', sentAt: null, via: '', answeredAt: null, note: '' },
      createdAt: at,
      updatedAt: at,
      __v: 0,
    });
  }

  // Inserción directa (sin timestamps automáticos) para respetar las fechas.
  if (chats.length) await ChatSimulation.collection.insertMany(chats, { ordered: false });
  if (records.length) await ManagedRecord.collection.insertMany(records, { ordered: false });

  let ticket = null;
  if (!(Number(business.roi?.avgTicket) > 0)) {
    ticket = TICKETS[business.industry] || TICKETS.otro;
    await Business.updateOne({ _id: business._id }, { $set: { 'roi.avgTicket': ticket } });
  }
  return { chats: chats.length, records: records.length, ticket };
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  const now = new Date();
  for (const email of emails) {
    const user = await User.findOne({ email }).select('_id name').lean();
    if (!user) {
      console.log(`\n✗ ${email}: no existe la cuenta. Se omite.`);
      continue;
    }
    const businesses = await Business.find({ owner: user._id }).select('name industry roi').lean();
    if (!businesses.length) {
      console.log(`\n✗ ${email}: no tiene negocios (falta terminar el onboarding). Se omite.`);
      continue;
    }
    const removed = await wipeDemo(businesses.map((b) => b._id));
    console.log(`\n● ${email}`);
    if (removed.chats || removed.records) console.log(`  Datos demo anteriores quitados: ${removed.chats} conversaciones, ${removed.records} registros.`);
    if (onlyDelete) continue;
    for (const b of businesses) {
      const r = await seedBusiness(b, now);
      console.log(`  ✓ ${b.name}: ${r.chats} conversaciones y ${r.records} registros de trabajo captado.`);
      if (r.ticket) console.log(`    Ticket promedio de ejemplo: $${r.ticket} MXN (cámbialo en Analíticas si quieres otro).`);
    }
  }
  await mongoose.disconnect();
  console.log(onlyDelete ? '\nListo: datos demo quitados.\n' : '\nListo. Recarga Analíticas e Inicio en el panel. Los datos duran ~18 días; vuelve a correrlo antes de grabar.\n');
}

main().catch(async (err) => {
  console.error('\nError:', err.message, '\n');
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
