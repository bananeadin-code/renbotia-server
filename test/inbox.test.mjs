// Bandeja optimizada (resumen calculado en la base) y /auth/me con el perfil completo.
import { setupDb, teardownDb, makeOwner } from './helpers.mjs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

describe('Bandeja y perfil tras la optimización', () => {
  let srv, A, ChatSimulation, UsageLog, startSession;

  before(async () => {
    await setupDb();
    ({ ChatSimulation } = await import('../src/models/ChatSimulation.js'));
    ({ UsageLog } = await import('../src/models/UsageLog.js'));
    ({ startSession } = await import('../src/services/session.service.js'));
    const { createApp } = await import('../src/app.js');
    srv = createApp().listen(0);
    A = `http://127.0.0.1:${srv.address().port}/api`;
  });
  after(async () => {
    srv?.close();
    await teardownDb();
  });

  const get = async (path, token) => {
    const r = await fetch(`${A}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return [r.status, await r.json()];
  };

  it('resumen de cada conversación igual que antes (último mensaje, conteo, ventana, alertas)', async () => {
    const o = await makeOwner('Bandeja');
    const { accessToken } = await startSession({ user: o.user, silent: true, context: { kind: 'owner', business: o.business._id } });
    const long = 'x'.repeat(200);
    await ChatSimulation.create({
      business: o.business._id,
      channel: 'whatsapp',
      customerPhone: '5216181112222',
      customerName: 'Rosa',
      needsAttention: true,
      hotLead: true,
      hotLeadReason: 'Quiere 3 pasteles',
      tags: ['vip'],
      messages: [
        { role: 'user', content: 'Hola, quiero pasteles', timestamp: new Date(Date.now() - 3600e3) },
        { role: 'assistant', content: long, timestamp: new Date() },
      ],
    });
    await ChatSimulation.create({
      business: o.business._id,
      channel: 'instagram',
      customerId: 'IG1',
      messages: [{ role: 'user', content: 'viejo', timestamp: new Date(Date.now() - 3 * 864e5) }],
    });
    const [s, j] = await get('/conversations', accessToken);
    assert.equal(s, 200);
    const rosa = j.data.conversations.find((c) => c.customerName === 'Rosa');
    assert.equal(rosa.messageCount, 2);
    assert.equal(rosa.lastRole, 'assistant');
    assert.equal(rosa.lastMessage.length, 90, 'recorte a 90 caracteres');
    assert.equal(rosa.whatsappWindow.open, true);
    assert.deepEqual(rosa.tags, ['vip']);
    assert.equal(rosa.hotLead, true);
    assert.equal(rosa.handoffMode, 'bot');
    const ig = j.data.conversations.find((c) => c.channel === 'instagram');
    assert.equal(ig.whatsappWindow.open, false, 'ventana de 24 h cerrada');
    assert.equal(j.data.needAttention, 1);
    assert.equal(j.data.hotLeads, 1);
  });

  it('pruebas del simulador: quién la hizo y sus tokens', async () => {
    const o = await makeOwner('Simu');
    const { accessToken } = await startSession({ user: o.user, silent: true, context: { kind: 'owner', business: o.business._id } });
    const chat = await ChatSimulation.create({
      business: o.business._id,
      channel: 'simulator',
      startedBy: o.user._id,
      messages: [
        { role: 'user', content: 'hola' },
        { role: 'assistant', content: 'hola!', tokens: 120 },
      ],
    });
    const [s1, j1] = await get('/conversations?scope=simulator', accessToken);
    assert.equal(s1, 200, JSON.stringify(j1).slice(0, 300));
    const c1 = j1.data.conversations.find((c) => String(c.id) === String(chat._id));
    assert.equal(c1.tokens, 120, 'suma de tokens de los mensajes');
    assert.equal(c1.startedBy.email, o.user.email);
    await UsageLog.create({ business: o.business._id, chat: chat._id, date: new Date(), totalTokens: 999, source: 'simulator' });
    const [, j2] = await get('/conversations?scope=simulator', accessToken);
    assert.equal(j2.data.conversations.find((c) => String(c.id) === String(chat._id)).tokens, 999, 'si hay registro de uso, manda ese');
  });

  it('/auth/me devuelve el perfil completo aunque requireAuth use un objeto ligero', async () => {
    const o = await makeOwner('Perfil');
    const { accessToken } = await startSession({ user: o.user, silent: true, context: { kind: 'owner', business: o.business._id } });
    const [s, j] = await get('/auth/me', accessToken);
    assert.equal(s, 200);
    assert.equal(String(j.data.user._id), String(o.user._id));
    assert.equal(j.data.user.email, o.user.email);
    assert.equal(j.data.user.passwordHash, undefined, 'nunca expone la contraseña');
  });
});
