// Seguimiento automático de punta a punta: con un historial largo, se envía UNA
// vez por WhatsApp y el historial completo se conserva (la consulta solo trae lo reciente).
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

describe('Seguimiento automático', () => {
  let Plan, Subscription, Business, BotConfig, ChatSimulation, runFollowUps;

  before(async () => {
    await setupDb();
    ({ Plan } = await import('../src/models/Plan.js'));
    ({ Subscription } = await import('../src/models/Subscription.js'));
    ({ Business } = await import('../src/models/Business.js'));
    ({ BotConfig } = await import('../src/models/BotConfig.js'));
    ({ ChatSimulation } = await import('../src/models/ChatSimulation.js'));
    ({ runFollowUps } = await import('../src/services/followUp.service.js'));
  });
  after(async () => {
    await teardownDb();
    graph.close();
  });

  it('escribe una sola vez al cliente callado y no recorta su historial', async () => {
    const o = await makeOwner('Seguimiento');
    const pro = await Plan.findOne({ key: 'pro' });
    await Subscription.updateOne({ business: o.business._id }, { $set: { plan: pro._id } });
    await Business.updateOne({ _id: o.business._id }, { $set: { whatsappPhoneNumberId: 'PN-FU-1' } });
    await BotConfig.updateOne(
      { business: o.business._id },
      { $set: { followUp: { enabled: true, delayHours: 4, mode: 'custom', message: '¿Sigues interesado en el corte?' } } }
    );

    const old = Date.now() - 6 * H;
    const history = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `mensaje ${i}`,
      via: i % 2 ? 'bot' : undefined,
      timestamp: new Date(old - (30 - i) * 60e3),
    }));
    const chat = await ChatSimulation.create({
      business: o.business._id,
      channel: 'whatsapp',
      customerPhone: '5216181234567',
      handoffMode: 'bot',
      messages: [
        ...history,
        { role: 'user', content: '¿Cuánto cuesta?', timestamp: new Date(old) },
        { role: 'assistant', content: 'Cuesta $150.', via: 'bot', timestamp: new Date(old + 1000) },
      ],
    });
    await ChatSimulation.updateOne({ _id: chat._id }, { $set: { updatedAt: new Date(old + 1000) } }, { timestamps: false });

    const first = await runFollowUps();
    assert.equal(first.sent, 1);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].body.text.body, '¿Sigues interesado en el corte?');
    assert.match(hits[0].url, /PN-FU-1\/messages$/);

    const after1 = await ChatSimulation.findById(chat._id).lean();
    assert.equal(after1.messages.length, 33, 'el historial completo sigue ahí');
    assert.equal(after1.messages.at(-1).followUp, true);

    // Segunda pasada: no se repite.
    const second = await runFollowUps();
    assert.equal(second.sent, 0);
    assert.equal(hits.length, 1);
  });
});
