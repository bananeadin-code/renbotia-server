// Sesiones en servidor (rotación, robo, cierre, inactividad, migración) y Fase 0
// (tope diario por cliente, bloquear contacto).
import { setupDb, teardownDb, makeOwner, DAY } from './helpers.mjs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

describe('sesiones en servidor', () => {
  let createApp, srv, A, Session, User, env, signRefreshToken, sent, realFetch;
  const UA1 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
  const UA2 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

  before(async () => {
    await setupDb();
    ({ createApp } = await import('../src/app.js'));
    ({ Session } = await import('../src/models/Session.js'));
    ({ User } = await import('../src/models/User.js'));
    ({ env } = await import('../src/config/env.js'));
    ({ signRefreshToken } = await import('../src/utils/jwt.js'));
    srv = createApp().listen(0);
    A = `http://127.0.0.1:${srv.address().port}/api`;
    // Correos: se capturan en vez de enviarse.
    env.resend.apiKey = 're_test';
    sent = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = async (u, opts) => {
      if (String(u).includes('resend')) {
        sent.push(JSON.parse(opts.body));
        return new Response('{"id":"1"}', { status: 200 });
      }
      return realFetch(u, opts);
    };
  });
  after(async () => {
    globalThis.fetch = realFetch;
    env.resend.apiKey = '';
    srv?.close();
    await teardownDb();
  });

  const cookieOf = (res) => (res.headers.get('set-cookie') || '').match(/refreshToken=([^;]*)/)?.[1] || '';
  async function login(o, ua = UA1) {
    const r = await realFetch(`${A}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': ua },
      body: JSON.stringify({ email: o.user.email, password: o.password }),
    });
    const j = await r.json();
    return { access: j.data.accessToken, refresh: cookieOf(r) };
  }
  const refresh = (cookie, ua = UA1) =>
    realFetch(`${A}/auth/refresh`, { method: 'POST', headers: { Cookie: `refreshToken=${cookie}`, 'User-Agent': ua } });
  const me = (access) => realFetch(`${A}/auth/me`, { headers: { Authorization: `Bearer ${access}` } });

  it('el login crea una sesión y la lista la marca como actual', async () => {
    const o = await makeOwner('Ses');
    const t = await login(o);
    assert.equal((await me(t.access)).status, 200);
    const list = await (await realFetch(`${A}/auth/sessions`, { headers: { Authorization: `Bearer ${t.access}` } })).json();
    assert.equal(list.data.sessions.length, 1);
    assert.equal(list.data.sessions[0].current, true);
    assert.equal(list.data.sessions[0].device, 'Chrome en Windows');
  });

  it('rota el refresh; reutilizar uno viejo (fuera de gracia) cierra la sesión y avisa', async () => {
    const o = await makeOwner('Rot');
    const t = await login(o);
    const r1 = await refresh(t.refresh);
    assert.equal(r1.status, 200);
    const newer = cookieOf(r1);
    assert.notEqual(newer, t.refresh, 'el refresh cambia en cada renovación');

    // Dentro del margen de gracia (otra pestaña con la cookie anterior): vale.
    assert.equal((await refresh(t.refresh)).status, 200);

    // Fuera del margen: se considera cookie copiada.
    await Session.updateMany({ user: o.user._id }, { $set: { prevValidUntil: new Date(Date.now() - 1000) } });
    sent.length = 0;
    assert.equal((await refresh(t.refresh)).status, 401);
    const s = await Session.findOne({ user: o.user._id });
    assert.equal(s.revokedReason, 'reuse');
    assert.equal((await refresh(newer)).status, 401, 'la sesión completa queda cerrada');
    const access = (await r1.json()).data.accessToken;
    assert.equal((await me(access)).status, 401, 'el acceso se corta de inmediato');
    assert.ok(sent.some((m) => /por seguridad/i.test(m.subject)), 'avisa por correo');
  });

  it('cerrar sesión la revoca en el servidor (la cookie copiada ya no sirve)', async () => {
    const o = await makeOwner('Out');
    const t = await login(o);
    await realFetch(`${A}/auth/logout`, { method: 'POST', headers: { Cookie: `refreshToken=${t.refresh}` } });
    assert.equal((await refresh(t.refresh)).status, 401);
    assert.equal((await me(t.access)).status, 401);
  });

  it('"cerrar las demás" deja viva solo la sesión actual', async () => {
    const o = await makeOwner('Two');
    const a = await login(o, UA1);
    const b = await login(o, UA2);
    const r = await (await realFetch(`${A}/auth/sessions/revoke-others`, { method: 'POST', headers: { Authorization: `Bearer ${a.access}` } })).json();
    assert.equal(r.data.closed, 1);
    assert.equal((await me(a.access)).status, 200);
    assert.equal((await me(b.access)).status, 401);
  });

  it('vence por inactividad y de forma absoluta', async () => {
    const o = await makeOwner('Idle');
    const t = await login(o);
    await Session.updateOne({ user: o.user._id }, { $set: { lastUsedAt: new Date(Date.now() - 8 * DAY) } });
    assert.equal((await refresh(t.refresh)).status, 401);
    const t2 = await login(o);
    await Session.updateOne({ user: o.user._id, revokedAt: null }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await refresh(t2.refresh)).status, 401);
  });

  it('restablecer la contraseña cierra todas las sesiones', async () => {
    const o = await makeOwner('Reset');
    const t = await login(o);
    const { resetPassword } = await import('../src/services/auth.service.js');
    const crypto = await import('node:crypto');
    const raw = 'x'.repeat(40);
    await User.updateOne(
      { _id: o.user._id },
      { $set: { resetToken: crypto.createHash('sha256').update(raw).digest('hex'), resetTokenExpiry: new Date(Date.now() + 60e3) } }
    );
    await resetPassword({ token: raw, password: 'OtraClave123!' });
    assert.equal((await me(t.access)).status, 401);
    assert.equal(await Session.countDocuments({ user: o.user._id, revokedAt: null }), 0);
  });

  it('migra tokens previos (sin sesión) sin sacar a nadie', async () => {
    const o = await makeOwner('Legacy');
    const user = await User.findById(o.user._id);
    const legacy = signRefreshToken({ sub: String(user._id), role: user.role, tv: user.tokenVersion ?? 0 });
    const r = await refresh(legacy);
    assert.equal(r.status, 200);
    assert.equal(await Session.countDocuments({ user: o.user._id }), 1);
  });

  it('avisa del dispositivo nuevo, no del conocido; y del bloqueo por intentos', async () => {
    const o = await makeOwner('Dev');
    sent.length = 0;
    await login(o, UA1); // primera sesión: sin aviso
    await login(o, UA1); // mismo dispositivo: sin aviso
    assert.equal(sent.filter((m) => /Nuevo inicio de sesión/.test(m.subject)).length, 0);
    await login(o, UA2); // iPhone nuevo
    assert.equal(sent.filter((m) => /Nuevo inicio de sesión/.test(m.subject)).length, 1);

    for (let i = 0; i < 8; i++) {
      await realFetch(`${A}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: o.user.email, password: 'mala-clave' }),
      });
    }
    assert.ok(sent.some((m) => /Bloqueamos temporalmente/.test(m.subject)));
  });

  it('recuperar contraseña ya no devuelve el token en la respuesta', async () => {
    const o = await makeOwner('Fgt');
    const j = await (await realFetch(`${A}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: o.user.email }),
    })).json();
    assert.equal(j.data?.resetToken, undefined);
  });
});

describe('Fase 0: tope por cliente y bloqueo', () => {
  let ChatSimulation, Business, processMessage, createApp, srv, A;
  before(async () => {
    await setupDb();
    ({ ChatSimulation } = await import('../src/models/ChatSimulation.js'));
    ({ Business } = await import('../src/models/Business.js'));
    ({ processMessage } = await import('../src/services/simulator.service.js'));
    ({ createApp } = await import('../src/app.js'));
    srv = createApp().listen(0);
    A = `http://127.0.0.1:${srv.address().port}/api`;
  });
  after(async () => {
    srv?.close();
    await teardownDb();
  });

  it('pasado el tope diario, el bot ya no responde (ni gasta) y marca la conversación', async () => {
    const o = await makeOwner('Cap');
    const now = Date.now();
    const msgs = Array.from({ length: 100 }, (_, i) => ({ role: 'user', content: `m${i}`, timestamp: new Date(now - i * 60e3) }));
    const chat = await ChatSimulation.create({ business: o.business._id, channel: 'whatsapp', customerPhone: '521', customerId: '521', messages: msgs });
    const business = await Business.findById(o.business._id);
    const r = await processMessage({ businessId: o.business._id, business, message: 'otro', chatId: chat._id, channel: 'whatsapp', source: 'whatsapp' });
    assert.equal(r.paused, true);
    assert.equal(r.pauseReason, 'customer_cap');
    const after = await ChatSimulation.findById(chat._id);
    assert.equal(after.needsAttention, true);
    assert.equal(after.messages.length, 101, 'el mensaje se guarda para el equipo');
  });

  it('bloquear y desbloquear un contacto desde la bandeja', async () => {
    const o = await makeOwner('Blk');
    // Sesión creada directo (las pruebas previas ya agotaron el límite de logins por IP).
    const { startSession } = await import('../src/services/session.service.js');
    const T = (await startSession({ user: o.user, silent: true })).accessToken;
    const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${T}`, 'X-Business-Id': String(o.business._id) };
    const chat = await ChatSimulation.create({ business: o.business._id, channel: 'instagram', customerId: 'IGSID1', customerName: 'Spam', messages: [] });
    let r = await fetch(`${A}/conversations/${chat._id}/block`, { method: 'POST', headers: H, body: JSON.stringify({ blocked: true }) });
    assert.equal(r.status, 200);
    const { isBlocked } = await import('../src/utils/blocklist.js');
    assert.equal(isBlocked(await Business.findById(o.business._id).lean(), 'instagram', 'IGSID1'), true);
    const detail = await (await fetch(`${A}/conversations/${chat._id}`, { headers: H })).json();
    assert.equal(detail.data.blocked, true);
    r = await fetch(`${A}/conversations/${chat._id}/block`, { method: 'POST', headers: H, body: JSON.stringify({ blocked: false }) });
    assert.equal(isBlocked(await Business.findById(o.business._id).lean(), 'instagram', 'IGSID1'), false);
  });
});
