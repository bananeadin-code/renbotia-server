// Fase 3: IAM ligero — roles, niveles por módulo, canales y migración.
import { setupDb, teardownDb, makeOwner } from './helpers.mjs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

describe('IAM: roles, módulos y canales', () => {
  let Membership, ChatSimulation, Plan, Subscription, startSession, createApp, srv, A, access;

  before(async () => {
    await setupDb();
    ({ Membership } = await import('../src/models/Membership.js'));
    ({ ChatSimulation } = await import('../src/models/ChatSimulation.js'));
    ({ Plan } = await import('../src/models/Plan.js'));
    ({ Subscription } = await import('../src/models/Subscription.js'));
    ({ startSession } = await import('../src/services/session.service.js'));
    access = await import('../src/config/access.js');
    ({ createApp } = await import('../src/app.js'));
    srv = createApp().listen(0);
    A = `http://127.0.0.1:${srv.address().port}/api`;
  });
  after(async () => {
    srv?.close();
    await teardownDb();
  });

  // Dueño (Pro, para poder invitar) + un colaborador con sesión de proyecto.
  async function team(memberFields = {}) {
    const owner = await makeOwner('Duena');
    const pro = await Plan.findOne({ key: 'pro' });
    await Subscription.updateOne({ business: owner.business._id }, { $set: { plan: pro._id } });
    const m = await makeOwner('Miembro');
    await Membership.create({ business: owner.business._id, user: m.user._id, role: 'colaborador', ...memberFields });
    const { accessToken: TM } = await startSession({ user: m.user, silent: true, context: { kind: 'member', business: owner.business._id } });
    const { accessToken: TO } = await startSession({ user: owner.user, silent: true, context: { kind: 'owner', business: owner.business._id } });
    return { owner, m, TM, TO };
  }
  const H = (t) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });
  const req = async (method, path, t, body) => {
    const r = await fetch(`${A}${path}`, { method, headers: H(t), body: body ? JSON.stringify(body) : undefined });
    return [r.status, await r.json().catch(() => null)];
  };

  it('los permisos de antes se traducen sin perder ni ganar acceso', () => {
    const a = access.legacyAccess({ simulator: true, training: false, profile: true, connections: false });
    assert.equal(a.modules.conversations, 'edit');
    assert.equal(a.modules.training, 'view');
    assert.equal(a.modules.profile, 'edit');
    assert.equal(a.modules.connections, 'view');
    assert.equal(a.modules.simulator, 'edit');
    assert.equal(a.channels, 'all');
    assert.equal(access.normalizeModules({ analytics: 'edit' }).analytics, 'view', 'analíticas no tiene editar');
  });

  it('Solo lectura: ve todo, no cambia nada', async () => {
    const { TM } = await team({ roleKey: 'readonly' });
    assert.equal((await req('GET', '/botconfig', TM))[0], 200);
    assert.equal((await req('GET', '/usage/analytics', TM))[0], 200);
    assert.equal((await req('GET', '/members', TM))[0], 200);
    const [s1, j1] = await req('PUT', '/botconfig', TM, { botName: 'X' });
    assert.equal(s1, 403);
    assert.equal(j1.details.code, 'PERMISSION_REQUIRED');
    assert.equal((await req('POST', '/simulator/message', TM, { message: 'hola' }))[0], 403);
  });

  it('Agente de ventas: atiende conversaciones pero no ve analíticas ni conexiones', async () => {
    const { TM } = await team({ roleKey: 'agent' });
    assert.equal((await req('GET', '/conversations', TM))[0], 200);
    assert.equal((await req('GET', '/usage/analytics', TM))[0], 403);
    assert.equal((await req('GET', '/usage/impact', TM))[0], 403, 'ingresos estimados = analíticas');
    assert.equal((await req('GET', '/connections', TM))[0], 403);
    assert.equal((await req('GET', '/business/audit', TM))[0], 403);
  });

  it('un rol limitado a Instagram no ve ni atiende WhatsApp', async () => {
    const { owner, TM } = await team({
      roleKey: 'custom',
      access: { modules: { conversations: 'edit' }, channels: ['instagram'] },
    });
    const wa = await ChatSimulation.create({ business: owner.business._id, channel: 'whatsapp', customerPhone: '521', messages: [] });
    const ig = await ChatSimulation.create({ business: owner.business._id, channel: 'instagram', customerId: 'IG1', messages: [] });
    const [, list] = await req('GET', '/conversations', TM);
    const ids = list.data.conversations.map((c) => String(c.id));
    assert.ok(ids.includes(String(ig._id)));
    assert.ok(!ids.includes(String(wa._id)), 'WhatsApp no aparece en su bandeja');
    assert.equal((await req('GET', `/conversations/${wa._id}`, TM))[0], 404, 'ni abriéndola por id');
    assert.equal((await req('PATCH', `/conversations/${wa._id}`, TM, { title: 'x' }))[0], 404);
    assert.equal((await req('GET', `/conversations/${ig._id}`, TM))[0], 200);
  });

  it('roles personalizados: el dueño los crea y asigna; un colaborador no cambia su propio rol', async () => {
    const { owner, m, TO, TM } = await team({ roleKey: 'admin' });
    // El dueño confirma identidad (modo sudo) para gestionar roles.
    const { Session } = await import('../src/models/Session.js');
    await Session.updateMany({}, { $set: { stepUpAt: new Date() } });

    const [sc, jc] = await req('POST', '/members/roles', TO, {
      name: 'Recepción',
      modules: { conversations: 'edit', management: 'edit' },
      channels: ['whatsapp'],
    });
    assert.equal(sc, 201);
    const roleKey = jc.data.roles.custom[0].key;

    // Un administrador puede gestionar al equipo, pero no su propio rol ni crear roles.
    const [self] = await req('PUT', `/members/${m.user._id}/role`, TM, { roleKey: 'readonly' });
    assert.equal(self, 400);
    const [mk] = await req('POST', '/members/roles', TM, { name: 'Otro', modules: {} });
    assert.equal(mk, 403);

    const [sa, ja] = await req('PUT', `/members/${m.user._id}/role`, TO, { roleKey });
    assert.equal(sa, 200);
    assert.equal(ja.data.access.roleName, 'Recepción');
    assert.deepEqual(ja.data.access.channels, ['whatsapp']);

    // Borrar el rol deja a sus miembros en Solo lectura.
    const id = roleKey.slice(5);
    const [sd, jd] = await req('DELETE', `/members/roles/${id}`, TO);
    assert.equal(sd, 200);
    assert.equal(jd.data.moved, 1);
    assert.equal((await Membership.findOne({ business: owner.business._id, user: m.user._id })).roleKey, 'readonly');
  });

  it('invitar con un rol: quien acepta entra con ese rol', async () => {
    const { TO, owner } = await team({ roleKey: 'admin' });
    const { Session } = await import('../src/models/Session.js');
    await Session.updateMany({}, { $set: { stepUpAt: new Date() } });
    const [si] = await req('POST', '/members/invite', TO, { email: 'nueva@test.dev', roleKey: 'readonly' });
    assert.ok(si === 200 || si === 201, `invite ${si}`);
    const { Invitation } = await import('../src/models/Invitation.js');
    const inv = await Invitation.findOne({ business: owner.business._id, email: 'nueva@test.dev' });
    assert.equal(inv.roleKey, 'readonly');
  });
});
