// Fase 2: contextos (dueño / proyecto), confirmación de identidad y seguridad del equipo.
import { setupDb, teardownDb, makeOwner } from './helpers.mjs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

describe('contextos de acceso y modo sudo', () => {
  let createApp, srv, A, Membership, Session, EmailOtp, Business, env, rawFetch;

  before(async () => {
    await setupDb();
    ({ createApp } = await import('../src/app.js'));
    ({ Membership } = await import('../src/models/Membership.js'));
    ({ Session } = await import('../src/models/Session.js'));
    ({ EmailOtp } = await import('../src/models/EmailOtp.js'));
    ({ Business } = await import('../src/models/Business.js'));
    ({ env } = await import('../src/config/env.js'));
    srv = createApp().listen(0);
    A = `http://127.0.0.1:${srv.address().port}/api`;
    rawFetch = globalThis.fetch;
  });
  after(async () => {
    srv?.close();
    await teardownDb();
  });

  // Cada prueba usa una IP distinta (CF-Connecting-IP): el límite de logins por IP no estorba.
  let ipSeq = 10;
  const nextIp = () => `10.0.0.${ipSeq++}`;
  const H = (t, ip, extra = {}) => ({ 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}), 'CF-Connecting-IP': ip, ...extra });
  const post = async (path, body, t, ip) => {
    const r = await rawFetch(`${A}${path}`, { method: 'POST', headers: H(t, ip), body: JSON.stringify(body || {}) });
    return [r.status, await r.json().catch(() => null), r];
  };
  const get = async (path, t, ip, extra) => {
    const r = await rawFetch(`${A}${path}`, { headers: H(t, ip, extra) });
    return [r.status, await r.json().catch(() => null)];
  };
  const setOtp = (userId, purpose, code) =>
    EmailOtp.findOneAndUpdate(
      { user: userId, purpose },
      { user: userId, purpose, codeHash: crypto.createHash('sha256').update(`${code}:${env.jwt.accessSecret}`).digest('hex'), attempts: 0, expiresAt: new Date(Date.now() + 600e3), lastSentAt: new Date(0) },
      { upsert: true }
    );

  // Dueña de su negocio que además colabora en el de otra persona.
  async function ownerAndMember() {
    const a = await makeOwner('Ana');
    const b = await makeOwner('Beto');
    await Membership.create({ business: b.business._id, user: a.user._id, role: 'colaborador' });
    return { a, b };
  }

  it('con varios contextos, el login pide elegir; el token de contexto es de un solo uso', async () => {
    const { a, b } = await ownerAndMember();
    const ip = nextIp();
    const [st, j] = await post('/auth/login', { email: a.user.email, password: a.password }, null, ip);
    assert.equal(st, 200);
    assert.equal(j.data.needsContext, true);
    assert.equal(j.data.contexts.length, 2);
    const ctxToken = j.data.contextToken;

    const [s2, j2] = await post('/auth/context/select', { contextToken: ctxToken, businessId: String(b.business._id) }, null, ip);
    assert.equal(s2, 200);
    assert.equal(j2.data.context.kind, 'member');
    const [s3] = await post('/auth/context/select', { contextToken: ctxToken, businessId: String(b.business._id) }, null, ip);
    assert.equal(s3, 401, 'el mismo token no abre otra sesión');
  });

  it('una sesión de proyecto solo ve ese negocio y no puede actuar como dueño', async () => {
    const { a, b } = await ownerAndMember();
    const ip = nextIp();
    const [, j] = await post('/auth/login', { email: a.user.email, password: a.password }, null, ip);
    const [, sel] = await post('/auth/context/select', { contextToken: j.data.contextToken, businessId: String(b.business._id) }, null, ip);
    const T = sel.data.accessToken;

    // Aunque el cliente pida su propio negocio por cabecera, la sesión manda.
    const [, me] = await get('/business/me', T, ip, { 'X-Business-Id': String(a.business._id) });
    assert.equal(String(me.data.business._id || me.data.business.id), String(b.business._id));
    // Comprar o invitar es de dueño.
    const [sb] = await post('/billing/intent', { kind: 'credits', packKey: 'pack_100k' }, T, ip);
    assert.equal(sb, 403);
    const [si] = await post('/members/invite', { email: 'x@test.dev' }, T, ip);
    assert.equal(si, 403);
  });

  it('pasar de proyecto a dueño exige confirmar identidad y cierra la sesión anterior', async () => {
    const { a, b } = await ownerAndMember();
    const ip = nextIp();
    const [, j] = await post('/auth/login', { email: a.user.email, password: a.password }, null, ip);
    const [, sel] = await post('/auth/context/select', { contextToken: j.data.contextToken, businessId: String(b.business._id) }, null, ip);
    const T = sel.data.accessToken;

    const [s1, j1] = await post('/auth/context/switch', { businessId: String(a.business._id) }, T, ip);
    assert.equal(s1, 403);
    assert.equal(j1.details.code, 'STEP_UP_REQUIRED');

    const [bad, jb] = await post('/auth/step-up', { password: 'equivocada' }, T, ip);
    assert.equal(bad, 401);
    assert.equal(jb.details.code, 'WRONG_PASSWORD');
    const [ok] = await post('/auth/step-up', { password: a.password }, T, ip);
    assert.equal(ok, 200);

    const [s2, j2] = await post('/auth/context/switch', { businessId: String(a.business._id) }, T, ip);
    assert.equal(s2, 200);
    assert.equal(j2.data.context.kind, 'owner');
    const [old] = await get('/auth/me', T, ip);
    assert.equal(old, 401, 'la sesión de proyecto quedó cerrada');
    const [, me] = await get('/business/me', j2.data.accessToken, ip);
    assert.equal(String(me.data.business._id || me.data.business.id), String(a.business._id));
  });

  it('un solo contexto entra directo; las acciones delicadas piden confirmar identidad', async () => {
    const o = await makeOwner('Solo');
    const ip = nextIp();
    const [, j] = await post('/auth/login', { email: o.user.email, password: o.password }, null, ip);
    assert.ok(j.data.accessToken);
    assert.equal(j.data.context.kind, 'owner');
    const T = j.data.accessToken;
    const [s1, j1] = await post('/members/invite', { email: 'nuevo@test.dev' }, T, ip);
    assert.equal(s1, 403);
    assert.equal(j1.details.code, 'STEP_UP_REQUIRED');
    await post('/auth/step-up', { password: o.password }, T, ip);
    const [, j2] = await post('/members/invite', { email: 'nuevo@test.dev' }, T, ip);
    // (En Free invitar está bloqueado por plan; lo que importa es que ya no lo
    // detiene la confirmación de identidad.)
    assert.notEqual(j2?.details?.code, 'STEP_UP_REQUIRED', 'tras confirmar, ya no lo bloquea el modo sudo');
  });

  it('el dueño exige 2FA al equipo: el colaborador entra con código; quitarlo del equipo lo saca', async () => {
    const { a, b } = await ownerAndMember();
    const ipB = nextIp();
    const ipA = nextIp();
    // Beto (dueño) activa el requisito.
    const [, jb] = await post('/auth/login', { email: b.user.email, password: b.password }, null, ipB);
    const TB = jb.data.accessToken;
    await post('/auth/step-up', { password: b.password }, TB, ipB);
    const put = await rawFetch(`${A}/members/security`, { method: 'PUT', headers: H(TB, ipB), body: JSON.stringify({ requireTeam2fa: true }) });
    assert.equal(put.status, 200);

    // Ana entra al proyecto de Beto sin 2FA en su login → se le pide código.
    const [, ja] = await post('/auth/login', { email: a.user.email, password: a.password }, null, ipA);
    const [, need] = await post('/auth/context/select', { contextToken: ja.data.contextToken, businessId: String(b.business._id) }, null, ipA);
    assert.equal(need.data.needsCode, true);
    await setOtp(a.user._id, 'context_2fa', '123456');
    const [sOk, jOk] = await post('/auth/context/select', { contextToken: ja.data.contextToken, businessId: String(b.business._id), code: '123456' }, null, ipA);
    assert.equal(sOk, 200);
    const TA = jOk.data.accessToken;
    const s = await Session.findOne({ user: a.user._id, 'context.business': b.business._id, revokedAt: null });
    assert.equal(s.mfa, true);

    // Beto ve la sesión de Ana y la quita del equipo: Ana pierde el acceso.
    const [, list] = await get(`/members/${a.user._id}/sessions`, TB, ipB);
    assert.equal(list.data.sessions.length, 1);
    const del = await rawFetch(`${A}/members/${a.user._id}`, { method: 'DELETE', headers: H(TB, ipB) });
    assert.equal(del.status, 200);
    const [gone] = await get('/business/me', TA, ipA);
    assert.equal(gone, 401);
  });

  it('el onboarding convierte la sesión de cuenta en sesión de dueño', async () => {
    const { User } = await import('../src/models/User.js');
    const u = new User({ name: 'Nuevo', email: `nuevo${Date.now()}@test.dev`, emailVerified: true, twoFactorEnabled: false });
    await u.setPassword('PruebaLocal123!');
    await u.save();
    const ip = nextIp();
    const [, j] = await post('/auth/login', { email: u.email, password: 'PruebaLocal123!' }, null, ip);
    const T = j.data.accessToken;
    const [st, jo] = await post('/onboarding', { planKey: 'free', business: { name: 'Mi Tienda' } }, T, ip);
    assert.equal(st, 201);
    assert.ok(jo.data.accessToken);
    const s = await Session.findOne({ user: u._id, revokedAt: null });
    assert.equal(s.context.kind, 'owner');
    assert.equal(String(s.context.business), String((await Business.findOne({ owner: u._id }))._id));
  });
});
