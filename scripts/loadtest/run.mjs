// Prueba de carga LOCAL de RenBotIA (nunca contra producción).
//
// - Levanta un Anthropic y un Meta FALSOS con las demoras reales (la IA tarda
//   1.2–3.5 s, Meta ~0.2 s): se mide TU servidor y TU base, sin gastar tokens ni
//   enviar WhatsApps reales.
// - Crea N negocios de prueba (mezcla Pro/Elite) en la base `rb_load`.
// - Arranca el servidor real (src/index.js) apuntando a esos falsos.
// - Fases: normal (100 negocios), pico (200) y estrés (200 con 4× mensajes).
// - Mide: aceptación del webhook, espera del cliente hasta la respuesta, panel
//   del dueño (latencia), errores, memoria y CPU del servidor.
//
// Uso: node scripts/loadtest/run.mjs   (requiere Mongo local en 127.0.0.1:27019)
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MONGO = process.env.LOAD_MONGO || 'mongodb://127.0.0.1:27019/rb_load';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)/.test(MONGO)) throw new Error('Solo contra un Mongo local.');
const FAKE_PORT = 7070;
const API_PORT = 5055;
const API = `http://127.0.0.1:${API_PORT}`;
const SECRET = 'loadtest-secret';
const N = Number(process.env.LOAD_BUSINESSES || 200);
const OUT = process.env.LOAD_OUT || path.join(ROOT, 'loadtest-report.json');

process.env.MONGODB_URI = MONGO;
process.env.NODE_ENV = 'development';
process.env.RESEND_API_KEY = '';
process.env.LOG_LEVEL = 'error';

/* ── Estadísticas ─────────────────────────────────────────────────────────── */
const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};
const summary = (arr) => ({ n: arr.length, p50: pct(arr, 50), p95: pct(arr, 95), p99: pct(arr, 99), max: arr.length ? Math.round(Math.max(...arr)) : null });

/* ── Anthropic + Meta falsos ──────────────────────────────────────────────── */
const fake = { ai: 0, aiInFlight: 0, aiPeak: 0, sends: 0, waiters: new Map() };
const REPLIES = [
  '¡Claro! Con gusto te ayudo. Nuestro horario es de 9 a 6 y tenemos servicio a domicilio.',
  'Sí tenemos disponible. ¿Te gustaría que te aparte uno para mañana?',
  'El precio es de $350 e incluye envío en la ciudad. ¿Te paso los datos para pagar?',
];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    if (req.url.startsWith('/v1/messages')) {
      fake.ai++;
      fake.aiInFlight++;
      fake.aiPeak = Math.max(fake.aiPeak, fake.aiInFlight);
      await delay(1200 + Math.random() * 2300); // tiempo real típico de Claude
      fake.aiInFlight--;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          id: `msg_${crypto.randomBytes(6).toString('hex')}`,
          type: 'message',
          role: 'assistant',
          model: JSON.parse(body || '{}').model || 'claude',
          content: [{ type: 'text', text: REPLIES[Math.floor(Math.random() * REPLIES.length)] }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 400, output_tokens: 90, cache_read_input_tokens: 1800, cache_creation_input_tokens: 0 },
        })
      );
    }
    if (/\/messages$/.test(req.url) && req.method === 'POST') {
      await delay(120 + Math.random() * 250); // Graph API
      fake.sends++;
      const to = JSON.parse(body || '{}').to;
      const q = fake.waiters.get(to);
      if (q?.length) q.shift()(Date.now());
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: `wamid.${crypto.randomBytes(8).toString('hex')}` }] }));
    }
    res.writeHead(404);
    res.end('{}');
  });
});

/* ── Datos de prueba ──────────────────────────────────────────────────────── */
async function seed() {
  const mongoose = (await import('mongoose')).default;
  await mongoose.connect(MONGO);
  await mongoose.connection.dropDatabase();
  const { PLANS } = await import('../../src/config/constants.js');
  const { Plan } = await import('../../src/models/Plan.js');
  const { User } = await import('../../src/models/User.js');
  const { Subscription } = await import('../../src/models/Subscription.js');
  const { Business } = await import('../../src/models/Business.js');
  const { provisionBusiness } = await import('../../src/services/business.service.js');
  const { startSession } = await import('../../src/services/session.service.js');
  await Plan.insertMany(PLANS);
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  const plans = Object.fromEntries((await Plan.find().lean()).map((p) => [p.key, p._id]));
  const out = [];
  for (let i = 0; i < N; i++) {
    const user = new User({ name: `Dueno ${i}`, email: `carga${i}@load.dev`, emailVerified: true, twoFactorEnabled: false });
    await user.setPassword('PruebaLocal123!');
    await user.save();
    const { business } = await provisionBusiness({ owner: user._id, planKey: 'free', business: { name: `Negocio ${i}` } });
    const plan = i % 5 < 2 ? 'elite' : 'pro'; // 40% Elite, 60% Pro
    await Subscription.updateOne({ business: business._id }, { $set: { plan: plans[plan], extraTokens: 50_000_000 } });
    const phoneNumberId = `LT${100000 + i}`;
    await Business.updateOne({ _id: business._id }, { $set: { whatsappPhoneNumberId: phoneNumberId } });
    const { accessToken } = await startSession({ user, silent: true, context: { kind: 'owner', business: business._id } });
    out.push({ i, phoneNumberId, token: accessToken, customers: Array.from({ length: 15 }, (_, k) => `52618${String(i).padStart(3, '0')}${String(k).padStart(4, '0')}`) });
  }
  await mongoose.disconnect();
  return out;
}

/* ── Servidor real ─────────────────────────────────────────────────────────── */
function startApi() {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      MONGODB_URI: MONGO,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`,
      WHATSAPP_GRAPH_URL: `http://127.0.0.1:${FAKE_PORT}`,
      WHATSAPP_TOKEN: 'fake-token',
      WHATSAPP_APP_SECRET: SECRET,
      FOLLOWUP_ENABLED: 'false',
      RENEWALS_ENABLED: 'false',
      REMINDERS_ENABLED: 'false',
      RECONCILE_ENABLED: 'false',
      STRIPE_SECRET_KEY: '',
      RESEND_API_KEY: '',
      ALERT_EMAIL: '',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => (startApi.errors = (startApi.errors || '') + d.toString().slice(0, 2000)));
  return child;
}

/** CPU (segundos acumulados) y memoria del proceso del servidor. */
function sampleProc(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('powershell', ['-NoProfile', '-Command', `$p=Get-Process -Id ${pid}; "$($p.CPU)|$($p.WorkingSet64)"`], (e, out) => {
        const [cpu, ws] = String(out || '').trim().split('|');
        resolve({ cpu: Number(cpu) || 0, rssMb: Math.round((Number(ws) || 0) / 1048576) });
      });
    } else {
      execFile('ps', ['-o', 'time=,rss=', '-p', String(pid)], (e, out) => {
        const [t, rss] = String(out || '').trim().split(/\s+/);
        const [h, m, s] = (t || '0:0:0').split(':').map(Number);
        resolve({ cpu: h * 3600 + m * 60 + s, rssMb: Math.round((Number(rss) || 0) / 1024) });
      });
    }
  });
}

/* ── Tráfico ──────────────────────────────────────────────────────────────── */
const QUESTIONS = ['Hola, ¿qué horario tienen?', '¿Tienen servicio a domicilio?', '¿Cuánto cuesta el paquete básico?', 'Quiero agendar para mañana', '¿Aceptan tarjeta?'];
const META_IPS = ['173.252.88.1', '173.252.88.2', '173.252.88.3', '66.220.149.10']; // pocas IPs, como Meta

async function sendWhatsApp(b, phase) {
  const from = b.customers[Math.floor(Math.random() * b.customers.length)];
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: b.phoneNumberId, display_phone_number: '5216180000000' },
              contacts: [{ profile: { name: 'Cliente Prueba' }, wa_id: from }],
              messages: [{ from, id: `wamid.${crypto.randomBytes(10).toString('hex')}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)] } }],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  const sig = `sha256=${crypto.createHmac('sha256', SECRET).update(raw).digest('hex')}`;
  const t0 = Date.now();
  // Espera de la respuesta del bot a ESTE cliente (cola por cliente).
  const replied = new Promise((resolve) => {
    if (!fake.waiters.has(from)) fake.waiters.set(from, []);
    fake.waiters.get(from).push(resolve);
  });
  phase.sent++;
  try {
    const r = await fetch(`${API}/webhooks/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig, 'cf-connecting-ip': META_IPS[phase.sent % META_IPS.length] },
      body: raw,
    });
    phase.ack.push(Date.now() - t0);
    if (r.status !== 200) phase.ackErrors[r.status] = (phase.ackErrors[r.status] || 0) + 1;
  } catch {
    phase.ackErrors.network = (phase.ackErrors.network || 0) + 1;
  }
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 60000));
  phase.pending.push(
    Promise.race([replied, timeout]).then((at) => {
      if (at) phase.e2e.push(at - t0);
      else phase.lost++;
    })
  );
}

const PANEL = ['/api/business/me', '/api/usage', '/api/conversations?scope=real', '/api/subscription/me'];
async function panelHit(b, phase) {
  const p = PANEL[Math.floor(Math.random() * PANEL.length)];
  const t0 = Date.now();
  try {
    const r = await fetch(`${API}${p}`, { headers: { authorization: `Bearer ${b.token}`, 'cf-connecting-ip': `10.20.${b.i % 250}.${(b.i * 7) % 250}` } });
    await r.arrayBuffer();
    phase.panel.push(Date.now() - t0);
    if (r.status >= 400) phase.panelErrors[r.status] = (phase.panelErrors[r.status] || 0) + 1;
  } catch {
    phase.panelErrors.network = (phase.panelErrors.network || 0) + 1;
  }
}

async function runPhase({ name, businesses, msgEverySec, panelEverySec, seconds, pid }) {
  const phase = { name, businesses: businesses.length, sent: 0, ack: [], ackErrors: {}, e2e: [], lost: 0, pending: [], panel: [], panelErrors: {}, health: [], cpu: [], rss: [] };
  const aiBefore = fake.ai;
  const end = Date.now() + seconds * 1000;
  const timers = [];
  // Cada negocio: mensajes de clientes y su dueño usando el panel (con desfase aleatorio).
  for (const b of businesses) {
    timers.push(setTimeout(function tick() {
      if (Date.now() > end) return;
      sendWhatsApp(b, phase);
      timers.push(setTimeout(tick, msgEverySec * 1000 * (0.5 + Math.random())));
    }, Math.random() * msgEverySec * 1000));
    timers.push(setTimeout(function ptick() {
      if (Date.now() > end) return;
      panelHit(b, phase);
      timers.push(setTimeout(ptick, panelEverySec * 1000 * (0.5 + Math.random())));
    }, Math.random() * panelEverySec * 1000));
  }
  // Salud del servidor (latencia de /api/health = qué tan libre está) + CPU/RAM.
  let lastCpu = (await sampleProc(pid)).cpu;
  let lastAt = Date.now();
  while (Date.now() < end) {
    const t0 = Date.now();
    try {
      await fetch(`${API}/api/health`);
      phase.health.push(Date.now() - t0);
    } catch {
      /* cuenta como lento */
    }
    const s = await sampleProc(pid);
    const now = Date.now();
    phase.cpu.push(Math.round(((s.cpu - lastCpu) / ((now - lastAt) / 1000)) * 100));
    phase.rss.push(s.rssMb);
    lastCpu = s.cpu;
    lastAt = now;
    await delay(2000);
  }
  timers.forEach(clearTimeout);
  await Promise.all(phase.pending); // espera respuestas pendientes (máx. 60 s c/u)
  return {
    fase: name,
    negocios: phase.businesses,
    mensajes_por_segundo: +(phase.sent / seconds).toFixed(1),
    mensajes: phase.sent,
    aceptacion_webhook_ms: summary(phase.ack),
    errores_webhook: phase.ackErrors,
    espera_cliente_ms: summary(phase.e2e),
    sin_respuesta_60s: phase.lost,
    panel_ms: summary(phase.panel),
    errores_panel: phase.panelErrors,
    salud_ms: summary(phase.health),
    cpu_servidor_pct: { promedio: Math.round(phase.cpu.reduce((a, b) => a + b, 0) / (phase.cpu.length || 1)), max: Math.max(0, ...phase.cpu) },
    memoria_mb: { max: Math.max(0, ...phase.rss) },
    llamadas_ia: fake.ai - aiBefore,
    ia_simultaneas_max: fake.aiPeak,
  };
}

/* ── Orquestación ─────────────────────────────────────────────────────────── */
await new Promise((r) => fakeServer.listen(FAKE_PORT, '127.0.0.1', r));
console.log(`Creando ${N} negocios de prueba…`);
const all = await seed();
const api = startApi();
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`${API}/api/health`)).ok) break;
  } catch {
    /* arrancando */
  }
  await delay(500);
}
console.log('Servidor listo. Corriendo fases…');
const results = [];
const plan = [
  { name: 'normal: 100 negocios, 1 mensaje/min c/u', businesses: all.slice(0, 100), msgEverySec: 60, panelEverySec: 15, seconds: 90 },
  { name: 'pico: 200 negocios, 3 mensajes/min c/u', businesses: all.slice(0, 200), msgEverySec: 20, panelEverySec: 10, seconds: 90 },
  { name: 'estrés: 200 negocios, 12 mensajes/min c/u', businesses: all.slice(0, 200), msgEverySec: 5, panelEverySec: 10, seconds: 60 },
];
for (const p of plan) {
  fake.aiPeak = 0;
  const r = await runPhase({ ...p, pid: api.pid });
  results.push(r);
  console.log(JSON.stringify(r, null, 1));
}
api.kill();
fakeServer.close();
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), negocios: N, results, serverErrors: (startApi.errors || '').slice(0, 1500) }, null, 2));
console.log(`\nReporte: ${OUT}`);
process.exit(0);
