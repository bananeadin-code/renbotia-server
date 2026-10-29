// Excepción de soporte TEAM_FREE_OWNERS: un negocio Free puede invitar colaboradores
// solo si el correo de su dueño está en la lista.
import { setupDb, teardownDb, makeOwner } from './helpers.mjs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

describe('Equipo en plan Free (excepción de soporte)', () => {
  let startSession, srv, A;
  before(async () => {
    await setupDb();
    ({ startSession } = await import('../src/services/session.service.js'));
    const { createApp } = await import('../src/app.js');
    srv = createApp().listen(0);
    A = `http://127.0.0.1:${srv.address().port}/api`;
  });
  after(async () => {
    delete process.env.TEAM_FREE_OWNERS;
    srv?.close();
    await teardownDb();
  });

  const call = async (method, path, t, body) => {
    const r = await fetch(`${A}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return [r.status, await r.json().catch(() => null)];
  };
  async function freeOwner() {
    const o = await makeOwner('Libre');
    const { accessToken, session } = await startSession({ user: o.user, silent: true, context: { kind: 'owner', business: o.business._id } });
    // Identidad recién confirmada (invitar pide step-up).
    const { Session } = await import('../src/models/Session.js');
    await Session.updateOne({ _id: session._id }, { $set: { stepUpAt: new Date() } });
    return { o, T: accessToken };
  }

  it('sin la excepción, Free no puede invitar', async () => {
    delete process.env.TEAM_FREE_OWNERS;
    const { T } = await freeOwner();
    const [s, j] = await call('POST', '/members/invite', T, { email: 'colab1@test.dev' });
    assert.equal(s, 403);
    assert.equal(j.details.code, 'PLAN_REQUIRED');
    const [, sub] = await call('GET', '/subscription/me', T);
    assert.equal(sub.data.subscription.teamUnlocked, false);
  });

  it('con el correo del dueño en TEAM_FREE_OWNERS, sí puede (y solo ese negocio)', async () => {
    const { o, T } = await freeOwner();
    const other = await freeOwner();
    process.env.TEAM_FREE_OWNERS = `otro@x.com, ${o.user.email.toUpperCase()}`;
    const [s] = await call('POST', '/members/invite', T, { email: 'colab2@test.dev' });
    assert.ok(s === 200 || s === 201, `estado ${s}`);
    const [, sub] = await call('GET', '/subscription/me', T);
    assert.equal(sub.data.subscription.teamUnlocked, true);
    const [s2] = await call('POST', '/members/invite', other.T, { email: 'colab3@test.dev' });
    assert.equal(s2, 403);
  });
});
