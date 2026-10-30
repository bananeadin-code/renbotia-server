// Cambio de contraseña desde el panel (autenticado): no depende de Turnstile,
// a diferencia del "olvidé mi contraseña" público.
import { setupDb, teardownDb, makeOwner } from './helpers.mjs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

describe('Cambio de contraseña desde el panel', () => {
  let startSession, srv, A;
  before(async () => {
    // Turnstile "activado" para el entorno de la prueba.
    process.env.TURNSTILE_SECRET_KEY = 'secret-de-prueba';
    await setupDb();
    ({ startSession } = await import('../src/services/session.service.js'));
    const { createApp } = await import('../src/app.js');
    srv = createApp().listen(0);
    A = `http://127.0.0.1:${srv.address().port}/api`;
  });
  after(async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    srv?.close();
    await teardownDb();
  });
  const post = (path, t, body) =>
    fetch(`${A}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });

  it('el "olvidé mi contraseña" público exige Turnstile', async () => {
    const r = await post('/auth/forgot-password', null, { email: 'x@test.dev' });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).details.code, 'CAPTCHA_REQUIRED');
  });

  it('autenticado: envía el enlace sin Turnstile', async () => {
    const o = await makeOwner('PwdReset');
    const { accessToken } = await startSession({ user: o.user, silent: true, context: { kind: 'owner', business: o.business._id } });
    const r = await post('/auth/password-reset', accessToken);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).success, true);
  });

  it('sin sesión: 401', async () => {
    const r = await post('/auth/password-reset', null);
    assert.equal(r.status, 401);
  });
});
