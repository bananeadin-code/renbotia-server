// Cifrado de tokens en reposo y anti-spam de alertas.
import { setupDb, teardownDb, makeOwner } from './helpers.mjs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const { Business } = await import('../src/models/Business.js');
const box = await import('../src/utils/secretBox.js');
const { encryptLegacySecrets } = await import('../src/services/encryptSecrets.service.js');

const raw = (id) => Business.collection.findOne({ _id: id });
const useKey = (k) => {
  process.env.DATA_ENCRYPTION_KEY = k;
  box._resetKeyCache();
};

describe('cifrado de tokens de Página', () => {
  before(setupDb);
  after(teardownDb);

  it('migra tokens en claro, los lee descifrados y no los corrompe al guardar', async () => {
    useKey('');
    const { business } = await makeOwner('Enc');
    await Business.updateOne({ _id: business._id }, { $set: { facebookPageId: 'p1', facebookPageToken: 'EAAG-legacy' } });
    assert.equal((await raw(business._id)).facebookPageToken, 'EAAG-legacy');

    useKey(crypto.randomBytes(32).toString('base64'));
    assert.ok((await encryptLegacySecrets()).updated >= 1);
    assert.match((await raw(business._id)).facebookPageToken, /^enc:v1:/);
    assert.equal((await encryptLegacySecrets()).updated, 0);

    const b = await Business.findOne({ facebookPageId: 'p1' }).select('+facebookPageToken +instagramPageToken');
    assert.equal(b.facebookPageToken, 'EAAG-legacy');
    b.instagramPageToken = 'IG-new';
    b.name = 'Otro nombre';
    await b.save();
    const r = await raw(business._id);
    assert.match(r.instagramPageToken, /^enc:v1:/);
    const again = await Business.findById(business._id).select('+facebookPageToken +instagramPageToken');
    assert.equal(again.facebookPageToken, 'EAAG-legacy');
    assert.equal(again.instagramPageToken, 'IG-new');
  });

  it('con una llave equivocada devuelve vacío en vez de tronar', async () => {
    const v = box.seal('secreto');
    useKey(crypto.randomBytes(32).toString('base64'));
    assert.equal(box.open(v), '');
  });
});

describe('alertas por correo', () => {
  it('agrupa errores iguales y respeta el tope diario', async () => {
    const { alertOps } = await import('../src/services/alert.service.js');
    process.env.ALERT_EMAIL = 'ops@test.dev';
    process.env.ALERT_DAILY_MAX = '2';
    const { env } = await import('../src/config/env.js');
    const prevKey = env.resend.apiKey;
    env.resend.apiKey = 're_test';
    const realFetch = globalThis.fetch;
    const sent = [];
    globalThis.fetch = async (u, o) => {
      sent.push(JSON.parse(o.body).subject);
      return new Response('{"id":"1"}', { status: 200 });
    };
    try {
      for (let i = 0; i < 5; i++) alertOps({ kind: 'http_500', message: `GET /x/${i} → boom ${i}` });
      alertOps({ kind: 'renewal', message: 'distinto' });
      alertOps({ kind: 'renewal', message: 'tercero (tope)' });
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(sent.length, 2);
    } finally {
      globalThis.fetch = realFetch;
      env.resend.apiKey = prevKey;
      process.env.ALERT_EMAIL = '';
    }
  });
});
