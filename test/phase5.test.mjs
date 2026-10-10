// Fase 5: confianza visible — "Tu seguridad", prueba de seguridad del bot y Turnstile.
import { setupDb, teardownDb, makeOwner } from './helpers.mjs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

describe('Fase 5: seguridad visible', () => {
  let srv, A, Business, Membership, ChatSimulation, ManagedRecord, Session, User, startSession, audit;

  before(async () => {
    await setupDb();
    ({ Business } = await import('../src/models/Business.js'));
    ({ Membership } = await import('../src/models/Membership.js'));
    ({ ChatSimulation } = await import('../src/models/ChatSimulation.js'));
    ({ ManagedRecord } = await import('../src/models/ManagedRecord.js'));
    ({ Session } = await import('../src/models/Session.js'));
    ({ User } = await import('../src/models/User.js'));
    ({ startSession } = await import('../src/services/session.service.js'));
    audit = await import('../src/services/botAudit.service.js');
    const { createApp } = await import('../src/app.js');
    srv = createApp().listen(0);
    A = `http://127.0.0.1:${srv.address().port}/api`;
  });
  after(async () => {
    audit.__setAuditTestHooks(null);
    delete process.env.TURNSTILE_SECRET_KEY;
    srv?.close();
    await teardownDb();
  });

  let ip = 0;
  const call = async (method, path, token, body) => {
    ip += 1;
    const r = await fetch(`${A}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `10.7.1.${ip % 250}`, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return [r.status, await r.json().catch(() => null)];
  };
  async function owner() {
    const o = await makeOwner('Seg');
    const { accessToken } = await startSession({ user: o.user, silent: true, context: { kind: 'owner', business: o.business._id } });
    return { ...o, token: accessToken };
  }

  it('"Tu seguridad": nivel según lo que tiene activo, con sugerencias opcionales', async () => {
    const o = await owner();
    await User.updateOne({ _id: o.user._id }, { $set: { twoFactorEnabled: false } });
    const [s1, j1] = await call('GET', '/auth/security', o.token);
    assert.equal(s1, 200);
    assert.equal(j1.data.level.key, 'basica');
    const v = j1.data.checks.find((c) => c.id === 'verificacion');
    assert.equal(v.ok, false);
    assert.equal(j1.data.checks.find((c) => c.id === 'llave').optional, true);

    await User.updateOne({ _id: o.user._id }, { $set: { twoFactorEnabled: true } });
    const [, j2] = await call('GET', '/auth/security', o.token);
    assert.equal(j2.data.level.key, 'buena', 'con verificación en dos pasos ya es "Buena" sin pasos opcionales');
    assert.ok(j2.data.recent.length >= 1);
    assert.ok(!j2.data.checks.some((c) => c.id === 'equipo'), 'sin equipo no sugiere verificación del equipo');

    const m = await makeOwner('Colab');
    await Membership.create({ business: o.business._id, user: m.user._id, role: 'colaborador' });
    const [, j3] = await call('GET', '/auth/security', o.token);
    assert.ok(j3.data.checks.some((c) => c.id === 'equipo' && c.optional));
  });

  it('prueba de seguridad del bot: sin efectos, con permiso y con espera entre corridas', async () => {
    const o = await owner();
    const calls = [];
    audit.__setAuditTestHooks({
      reply: async ({ messages, executeTool }) => {
        calls.push(messages[0].content);
        // El bot "escala" un caso: no debe avisar a nadie ni crear nada.
        if (/descuento/.test(messages[0].content)) await executeTool('escalar_a_humano', { motivo: 'x' });
        return { text: 'Con gusto te ayudo con lo del negocio.', totalTokens: 100, billableTokens: 100, toolCalls: [] };
      },
      judge: async () => ({
        text: JSON.stringify(audit.AUDIT_CASES.map((c) => ({ id: c.id, ok: c.id !== 'descuento', motivo: 'm', sugerencia: c.id === 'descuento' ? 'Agrega tu política de descuentos.' : '' }))),
        totalTokens: 50,
        billableTokens: 50,
      }),
    });
    const before = await ChatSimulation.countDocuments({ business: o.business._id });
    const [s, j] = await call('POST', '/botconfig/audit', o.token);
    assert.equal(s, 200, JSON.stringify(j));
    assert.equal(calls.length, audit.AUDIT_CASES.length);
    assert.equal(j.data.audit.passed, audit.AUDIT_CASES.length - 1);
    const fail = j.data.audit.results.find((r) => r.id === 'descuento');
    assert.equal(fail.ok, false);
    assert.match(fail.tip, /descuentos/);
    assert.equal(await ChatSimulation.countDocuments({ business: o.business._id }), before, 'no guarda conversaciones');
    assert.equal(await ManagedRecord.countDocuments({ business: o.business._id }), 0, 'no crea registros');

    // Se puede consultar después; correrla de nuevo enseguida espera.
    const [, g] = await call('GET', '/botconfig/audit', o.token);
    assert.equal(g.data.audit.total, audit.AUDIT_CASES.length);
    const [s2, j2] = await call('POST', '/botconfig/audit', o.token);
    assert.equal(s2, 429);
    assert.equal(j2.details.code, 'AUDIT_COOLDOWN');

    // Un rol de solo lectura puede ver el resultado pero no correrla (gasta tokens).
    const m = await makeOwner('Lector');
    await Membership.create({ business: o.business._id, user: m.user._id, role: 'colaborador', roleKey: 'readonly' });
    const { accessToken: TR } = await startSession({ user: m.user, silent: true, context: { kind: 'member', business: o.business._id } });
    assert.equal((await call('GET', '/botconfig/audit', TR))[0], 200);
    assert.equal((await call('POST', '/botconfig/audit', TR))[0], 403);
  });

  it('si el bot copia sus instrucciones, la prueba falla aunque el evaluador diga que no', () => {
    const system = 'Eres el asistente del negocio Cafe Prueba y debes responder siempre con amabilidad y precisión a cada cliente.';
    assert.equal(audit.leaksPrompt('Claro: eres el asistente del negocio cafe prueba y debes responder siempre con amabilidad', system), true);
    assert.equal(audit.leaksPrompt('No puedo compartir eso, pero con gusto te ayudo.', system), false);
    assert.deepEqual(audit.parseVerdicts('texto [{"id":"a","ok":true}] fin'), [{ id: 'a', ok: true }]);
    assert.deepEqual(audit.parseVerdicts('sin json'), []);
  });

  it('Turnstile: apagado no estorba; encendido exige la confirmación en el registro', async () => {
    const body = { name: 'Bot Malo', email: `bot${Date.now()}@test.dev`, password: 'ClaveSegura123!' };
    delete process.env.TURNSTILE_SECRET_KEY;
    const [, cfg] = await call('GET', '/auth/config');
    assert.equal(cfg.data.turnstileSiteKey, '');
    assert.notEqual((await call('POST', '/auth/register', null, body))[0], 400);

    process.env.TURNSTILE_SECRET_KEY = 'secreto-de-prueba';
    process.env.TURNSTILE_SITE_KEY = 'publica-de-prueba';
    const [, cfg2] = await call('GET', '/auth/config');
    assert.equal(cfg2.data.turnstileSiteKey, 'publica-de-prueba');
    const [s, j] = await call('POST', '/auth/register', null, { ...body, email: `bot2${Date.now()}@test.dev` });
    assert.equal(s, 400);
    assert.equal(j.details.code, 'CAPTCHA_REQUIRED');
    delete process.env.TURNSTILE_SECRET_KEY;
    delete process.env.TURNSTILE_SITE_KEY;
  });
});
