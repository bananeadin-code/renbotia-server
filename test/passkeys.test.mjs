// Fase 4: llaves de acceso (WebAuthn) con un autenticador de software real
// (llave P-256, datos CBOR y firma ECDSA), como lo haría un teléfono.
import { setupDb, teardownDb, makeOwner } from './helpers.mjs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/** Autenticador de software: crea credenciales y firma retos. */
function softAuthenticator(rpID, origin) {
  const { isoCBOR } = globalThis.__helpers;
  const creds = new Map();
  const rpHash = crypto.createHash('sha256').update(rpID).digest();
  const counter = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  return {
    create(options, { originOverride } = {}) {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const jwk = publicKey.export({ format: 'jwk' });
      const credId = crypto.randomBytes(16);
      const cose = new Map([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, 'base64url')],
        [-3, Buffer.from(jwk.y, 'base64url')],
      ]);
      const credLen = Buffer.alloc(2);
      credLen.writeUInt16BE(credId.length);
      const authData = Buffer.concat([rpHash, Buffer.from([0x45]), counter(0), Buffer.alloc(16), credLen, credId, Buffer.from(isoCBOR.encode(cose))]);
      const attestationObject = isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: originOverride || origin, crossOrigin: false }));
      const id = b64u(credId);
      creds.set(id, { privateKey, count: 0, userHandle: options.user.id });
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      };
    },
    sign(id, options, { originOverride } = {}) {
      const c = creds.get(id);
      c.count += 1;
      const authData = Buffer.concat([rpHash, Buffer.from([0x05]), counter(c.count)]);
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: originOverride || origin, crossOrigin: false }));
      const signature = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(clientDataJSON).digest()]), c.privateKey);
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: c.userHandle },
        clientExtensionResults: {},
      };
    },
  };
}

describe('Llaves de acceso (passkeys)', () => {
  let srv, A, Session, startSession, auth, rp;

  before(async () => {
    await setupDb();
    globalThis.__helpers = await import('@simplewebauthn/server/helpers');
    ({ Session } = await import('../src/models/Session.js'));
    ({ startSession } = await import('../src/services/session.service.js'));
    const { relyingParty } = await import('../src/services/passkey.service.js');
    rp = relyingParty();
    auth = softAuthenticator(rp.rpID, rp.origins[0]);
    const { createApp } = await import('../src/app.js');
    srv = createApp().listen(0);
    A = `http://127.0.0.1:${srv.address().port}/api`;
  });
  after(async () => {
    srv?.close();
    await teardownDb();
  });

  let ipSeq = 0;
  const call = async (method, path, token, body) => {
    ipSeq += 1;
    const r = await fetch(`${A}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': `10.9.0.${ipSeq % 250}`,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return [r.status, await r.json().catch(() => null)];
  };
  async function loggedIn() {
    const o = await makeOwner('Llave');
    const { accessToken } = await startSession({ user: o.user, silent: true, context: { kind: 'owner', business: o.business._id } });
    return { ...o, token: accessToken };
  }
  const sudo = () => Session.updateMany({}, { $set: { stepUpAt: new Date() } });

  async function register(token) {
    const [, opt] = await call('POST', '/auth/passkeys/register/options', token);
    const response = auth.create(opt.data.options);
    const [s, j] = await call('POST', '/auth/passkeys/register/verify', token, { challengeId: opt.data.challengeId, response });
    return { s, j, id: response.id };
  }

  it('agregar una llave pide confirmar identidad y luego la guarda', async () => {
    const { token } = await loggedIn();
    const [s0, j0] = await call('POST', '/auth/passkeys/register/options', token);
    assert.equal(s0, 403);
    assert.equal(j0.details.code, 'STEP_UP_REQUIRED');
    await sudo();
    const { s, j } = await register(token);
    assert.equal(s, 201);
    assert.equal(j.data.passkeys.length, 1);
    assert.match(j.data.passkeys[0].name, /Safari|iPhone|iOS/);
  });

  it('entrar con la llave: sesión con segundo factor y sin código por correo', async () => {
    const { token, user } = await loggedIn();
    await sudo();
    const { id } = await register(token);
    const [, opt] = await call('POST', '/auth/passkeys/login/options');
    const [s, j] = await call('POST', '/auth/passkeys/login/verify', null, { challengeId: opt.data.challengeId, response: auth.sign(id, opt.data.options) });
    assert.equal(s, 200, JSON.stringify(j));
    assert.ok(j.data.accessToken);
    assert.equal(j.data.user.email, user.email);
    const sess = await Session.findOne({ user: user._id }).sort({ createdAt: -1 }).lean();
    assert.equal(sess.mfa, true);
  });

  it('un reto no se puede reutilizar (repetición) y otro sitio no sirve (phishing)', async () => {
    const { token } = await loggedIn();
    await sudo();
    const { id } = await register(token);
    const [, opt] = await call('POST', '/auth/passkeys/login/options');
    const signed = auth.sign(id, opt.data.options);
    assert.equal((await call('POST', '/auth/passkeys/login/verify', null, { challengeId: opt.data.challengeId, response: signed }))[0], 200);
    assert.equal((await call('POST', '/auth/passkeys/login/verify', null, { challengeId: opt.data.challengeId, response: signed }))[0], 400, 'reto ya usado');

    const [, opt2] = await call('POST', '/auth/passkeys/login/options');
    const fake = auth.sign(id, opt2.data.options, { originOverride: 'https://renbotia-login.com' });
    assert.equal((await call('POST', '/auth/passkeys/login/verify', null, { challengeId: opt2.data.challengeId, response: fake }))[0], 401);
  });

  it('confirmar identidad con llave (step-up) y solo con llaves propias', async () => {
    const a = await loggedIn();
    const b = await loggedIn();
    await sudo();
    const { id: idA } = await register(a.token);
    await Session.updateMany({}, { $set: { stepUpAt: null } });

    const [, opt] = await call('POST', '/auth/step-up/passkey/options', a.token);
    const [s, j] = await call('POST', '/auth/step-up/passkey/verify', a.token, { challengeId: opt.data.challengeId, response: auth.sign(idA, opt.data.options) });
    assert.equal(s, 200);
    assert.equal(j.data.mfa, true);

    // B no tiene llaves; y no puede usar la de A para confirmar su sesión.
    assert.equal((await call('POST', '/auth/step-up/passkey/options', b.token))[0], 400);
    const [, optA] = await call('POST', '/auth/step-up/passkey/options', a.token);
    assert.equal((await call('POST', '/auth/step-up/passkey/verify', b.token, { challengeId: optA.data.challengeId, response: auth.sign(idA, optA.data.options) }))[0], 400);
  });

  it('quitar una llave pide confirmar identidad; después ya no sirve para entrar', async () => {
    const { token } = await loggedIn();
    await sudo();
    const { j, id } = await register(token);
    const pkId = j.data.passkeys[0].id;
    await Session.updateMany({}, { $set: { stepUpAt: null } });
    assert.equal((await call('DELETE', `/auth/passkeys/${pkId}`, token))[0], 403);
    await sudo();
    const [s, d] = await call('DELETE', `/auth/passkeys/${pkId}`, token);
    assert.equal(s, 200);
    assert.equal(d.data.passkeys.length, 0);
    const [, opt] = await call('POST', '/auth/passkeys/login/options');
    const [s2, j2] = await call('POST', '/auth/passkeys/login/verify', null, { challengeId: opt.data.challengeId, response: auth.sign(id, opt.data.options) });
    assert.equal(s2, 401);
    assert.equal(j2.details.code, 'PASSKEY_UNKNOWN');
  });
});
