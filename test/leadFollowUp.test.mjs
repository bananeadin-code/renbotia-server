// Leads y casos sin atender: recordatorio al dueño (una vez), resumen diario,
// aviso al cliente a las ~4 h (una vez, en ventana y en buena hora), y nada si
// alguien del equipo ya respondió o si es de madrugada.
import http from 'node:http';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Graph API falsa: registra lo que se manda a WhatsApp.
const hits = [];
const graph = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    hits.push({ url: req.url, body: body ? JSON.parse(body) : null });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ messages: [{ id: `wamid.${hits.length}` }] }));
  });
});
await new Promise((r) => graph.listen(0, '127.0.0.1', r));
process.env.WHATSAPP_GRAPH_URL = `http://127.0.0.1:${graph.address().port}`;
process.env.WHATSAPP_TOKEN = 'token-de-prueba';

const { setupDb, teardownDb, makeOwner } = await import('./helpers.mjs');

const H = 3600e3;
// Martes 24 de noviembre de 2026, 12:00 en Ciudad de México (UTC-6): buena hora.
const NOON = new Date('2026-11-24T18:00:00Z').getTime();

describe('Leads sin atender', () => {
  let Business, ChatSimulation, runLeadFollowUps, CHECKIN_TEXT;

  before(async () => {
    await setupDb();
    ({ Business } = await import('../src/models/Business.js'));
    ({ ChatSimulation } = await import('../src/models/ChatSimulation.js'));
    ({ runLeadFollowUps, CHECKIN_TEXT } = await import('../src/services/leadFollowUp.service.js'));
  });
  after(async () => {
    await teardownDb();
    graph.close();
  });

  async function hotLeadChat(business, { flaggedHoursAgo, now, extra = {} }) {
    const at = now - flaggedHoursAgo * H;
    return ChatSimulation.create({
      business,
      channel: 'whatsapp',
      customerPhone: '5216180000001',
      customerName: 'Alexander',
      handoffMode: 'bot',
      hotLead: true,
      hotLeadAt: new Date(at),
      hotLeadReason: 'Quiere una cita esta semana',
      messages: [
        { role: 'user', content: 'Quiero una cita', timestamp: new Date(at - 60e3) },
        { role: 'assistant', content: 'Un abogado te contactará.', via: 'bot', timestamp: new Date(at) },
      ],
      ...extra,
    });
  }

  it('avisa al dueño a las 2 h y al cliente a las 4 h, una sola vez cada uno', async () => {
    const o = await makeOwner('LeadsSinAtender');
    await Business.updateOne({ _id: o.business._id }, { $set: { whatsappPhoneNumberId: 'PN-LEAD-1' } });
    const chat = await hotLeadChat(o.business._id, { flaggedHoursAgo: 3, now: NOON });

    // 3 h: recordatorio al dueño, todavía no al cliente.
    const r1 = await runLeadFollowUps(NOON);
    assert.equal(r1.emails, 1);
    assert.equal(r1.checkIns, 0);
    let c = await ChatSimulation.findById(chat._id).lean();
    assert.ok(c.ownerReminderAt, 'queda registrado el recordatorio');

    // Otra pasada a la misma hora: no repite.
    const r2 = await runLeadFollowUps(NOON + 5 * 60e3);
    assert.equal(r2.emails, 0);

    // 5 h: aviso al cliente (texto fijo, por WhatsApp) y se guarda en el hilo.
    const before = hits.length;
    const r3 = await runLeadFollowUps(NOON + 2 * H);
    assert.equal(r3.checkIns, 1);
    assert.equal(hits.length, before + 1);
    assert.equal(hits.at(-1).body.text.body, CHECKIN_TEXT);
    assert.match(hits.at(-1).url, /PN-LEAD-1\/messages$/);
    c = await ChatSimulation.findById(chat._id).lean();
    assert.equal(c.messages.at(-1).content, CHECKIN_TEXT);

    // Y no se vuelve a mandar.
    const r4 = await runLeadFollowUps(NOON + 3 * H);
    assert.equal(r4.checkIns, 0);
  });

  it('no hace nada si alguien del equipo ya respondió', async () => {
    const o = await makeOwner('LeadAtendido');
    await Business.updateOne({ _id: o.business._id }, { $set: { whatsappPhoneNumberId: 'PN-LEAD-2' } });
    const chat = await hotLeadChat(o.business._id, { flaggedHoursAgo: 5, now: NOON });
    await ChatSimulation.updateOne(
      { _id: chat._id },
      { $push: { messages: { role: 'assistant', content: 'Hola, soy del equipo.', via: 'agent', timestamp: new Date(NOON - H) } } }
    );
    const before = hits.length;
    await runLeadFollowUps(NOON);
    const c = await ChatSimulation.findById(chat._id).lean();
    assert.equal(c.ownerReminderAt, null);
    assert.equal(c.handoffCheckInAt, null);
    assert.equal(hits.length, before);
  });

  it('de madrugada no avisa a nadie', async () => {
    const o = await makeOwner('LeadMadrugada');
    await Business.updateOne({ _id: o.business._id }, { $set: { whatsappPhoneNumberId: 'PN-LEAD-3' } });
    const night = new Date('2026-11-25T09:00:00Z').getTime(); // 3:00 en Ciudad de México
    const chat = await hotLeadChat(o.business._id, { flaggedHoursAgo: 5, now: night });
    const before = hits.length;
    await runLeadFollowUps(night);
    const c = await ChatSimulation.findById(chat._id).lean();
    assert.equal(c.ownerReminderAt, null);
    assert.equal(c.handoffCheckInAt, null);
    assert.equal(hits.length, before);
  });

  it('resumen diario con casos de más de un día; sin escribir al cliente fuera de la ventana de 24 h', async () => {
    const o = await makeOwner('LeadResumen');
    await Business.updateOne({ _id: o.business._id }, { $set: { whatsappPhoneNumberId: 'PN-LEAD-4' } });
    const chat = await hotLeadChat(o.business._id, {
      flaggedHoursAgo: 26,
      now: NOON,
      extra: { ownerReminderAt: new Date(NOON - 24 * H) }, // ya tuvo su recordatorio de 2 h
    });
    const before = hits.length;
    const r = await runLeadFollowUps(NOON);
    assert.equal(r.emails, 1, 'manda el resumen diario');
    assert.equal(r.checkIns, 0);
    assert.equal(hits.length, before, 'fuera de la ventana de Meta no se le escribe');
    const b = await Business.findById(o.business._id).lean();
    assert.ok(b.leadDigestAt);
    // Mismo día: no repite el resumen.
    const r2 = await runLeadFollowUps(NOON + 2 * H);
    assert.equal(r2.emails, 0);
    assert.ok(await ChatSimulation.exists({ _id: chat._id }));
  });
});
