// Embudo comercial: origen del registro, etapas automáticas, permisos del equipo
// y API de Conversiones de Meta (solo con consentimiento).
import { setupDb, teardownDb, makeOwner } from './helpers.mjs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

describe('Embudo comercial', () => {
  let srv, A, startSession, User, Business, Lead, funnel, conversions;
  before(async () => {
    await setupDb();
    ({ startSession } = await import('../src/services/session.service.js'));
    ({ User } = await import('../src/models/User.js'));
    ({ Business } = await import('../src/models/Business.js'));
    ({ Lead } = await import('../src/models/Lead.js'));
    funnel = await import('../src/services/funnel.service.js');
    conversions = await import('../src/services/conversions.service.js');
    const { createApp } = await import('../src/app.js');
    srv = createApp().listen(0);
    A = `http://127.0.0.1:${srv.address().port}/api`;
  });
  after(async () => {
    srv?.close();
    await teardownDb();
  });

  const call = async (method, path, t, body) => {
    const r = await fetch(`${A}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return [r.status, await r.json().catch(() => null)];
  };
  const tokenFor = async (user) => (await startSession({ user, silent: true })).accessToken;

  it('el registro guarda el origen (UTM/anuncio) y el canal se clasifica', async () => {
    const [s] = await call('POST', '/auth/register', null, {
      name: 'Ana Pauta',
      email: 'ana.pauta@test.dev',
      password: 'PruebaLocal123!',
      acq: { source: 'facebook', medium: 'paid', campaign: 'lanzamiento', fbclid: 'abc123', adsConsent: true },
    });
    assert.ok(s === 200 || s === 201, `registro ${s}`);
    const u = await User.findOne({ email: 'ana.pauta@test.dev' }).lean();
    assert.equal(u.acquisition.source, 'facebook');
    assert.equal(u.acquisition.campaign, 'lanzamiento');
    assert.equal(u.acquisition.adsConsent, true);
    assert.equal(funnel.channelOf(u), 'meta');
    assert.equal(funnel.channelOf({ acquisition: { gclid: 'x' } }), 'google');
    assert.equal(funnel.channelOf({ acquisition: {} }), 'directo');
    assert.equal(funnel.channelOf({ acquisition: {}, referredBy: 'x' }), 'referido');
  });

  it('etapas automáticas: verificado → negocio → conectado', async () => {
    const o = await makeOwner('Etapas');
    await funnel.onSignupComplete(o.user);
    assert.ok(await Lead.findOne({ user: o.user._id }), 'se crea la ficha de seguimiento');
    let row = (await funnel.funnelRows()).find((r) => r.userId === String(o.user._id));
    assert.equal(row.autoStage, 'negocio');
    await Business.updateOne({ _id: o.business._id }, { $set: { whatsappPhoneNumberId: 'PN-FUNNEL' } });
    row = (await funnel.funnelRows()).find((r) => r.userId === String(o.user._id));
    assert.equal(row.autoStage, 'conectado');
    assert.deepEqual(row.channels, ['whatsapp']);
  });

  it('soporte gestiona el seguimiento pero no ve montos ni el resumen; un cliente no entra', async () => {
    const staff = await makeOwner('Soporte');
    await User.updateOne({ _id: staff.user._id }, { $set: { role: 'soporte' } });
    const staffUser = await User.findById(staff.user._id);
    const TS = await tokenFor(staffUser);
    const target = await makeOwner('Prospecto');

    const [sl, jl] = await call('GET', '/funnel/leads', TS);
    assert.equal(sl, 200);
    assert.ok(jl.data.leads.length > 0);
    assert.equal('revenueMXN' in jl.data.leads[0], false, 'soporte no ve ingresos');
    assert.equal((await call('GET', '/funnel/summary', TS))[0], 403);

    const [su] = await call('PATCH', `/funnel/leads/${target.user._id}`, TS, { stage: 'contactado', assigneeId: String(staff.user._id), phone: '6181234567' });
    assert.equal(su, 200);
    const [sn, jn] = await call('POST', `/funnel/leads/${target.user._id}/notes`, TS, { text: 'Llamada: agendamos conexión asistida el jueves.' });
    assert.equal(sn, 201);
    assert.equal(jn.data.notes.at(-1).byName, 'Soporte');
    const lead = await Lead.findOne({ user: target.user._id });
    assert.equal(lead.stage, 'contactado');
    assert.ok(lead.firstContactAt);

    const cliente = await makeOwner('Cliente');
    assert.equal((await call('GET', '/funnel/leads', await tokenFor(cliente.user)))[0], 403);
    // No se puede asignar a alguien fuera del equipo.
    const [sb] = await call('PATCH', `/funnel/leads/${target.user._id}`, TS, { assigneeId: String(cliente.user._id) });
    assert.equal(sb, 400);
  });

  it('API de Conversiones: solo con consentimiento y con el mismo event_id', async () => {
    const { env } = await import('../src/config/env.js');
    const sent = [];
    const realFetch = globalThis.fetch;
    env.metaCapi.pixelId = '123';
    env.metaCapi.token = 'tok';
    globalThis.fetch = async (url, init) => {
      sent.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response('{}', { status: 200 });
    };
    try {
      const user = { _id: 'u1', email: 'Ana@Test.dev', acquisition: { adsConsent: false } };
      const r1 = await conversions.sendMetaEvent({ name: 'CompleteRegistration', eventId: 'reg_u1', user });
      assert.equal(r1.skipped, 'no_consent');
      assert.equal(sent.length, 0);

      user.acquisition = { adsConsent: true, fbclid: 'abc', fbp: 'fb.1.1.1', ip: '1.2.3.4', userAgent: 'UA' };
      const r2 = await conversions.sendMetaEvent({ name: 'Purchase', eventId: 'pay_pi_1', user, custom: { value: 429, currency: 'MXN' } });
      assert.equal(r2.ok, true);
      const ev = sent[0].body.data[0];
      assert.match(sent[0].url, /\/v\d+\.0\/123\/events/);
      assert.equal(ev.event_id, 'pay_pi_1');
      assert.equal(ev.action_source, 'website');
      assert.equal(ev.user_data.em[0].length, 64, 'correo en SHA-256');
      assert.notEqual(ev.user_data.em[0], 'ana@test.dev');
      assert.match(ev.user_data.fbc, /^fb\.1\.\d+\.abc$/);
      assert.equal(ev.custom_data.value, 429);
    } finally {
      globalThis.fetch = realFetch;
      env.metaCapi.pixelId = '';
      env.metaCapi.token = '';
    }
  });
});
