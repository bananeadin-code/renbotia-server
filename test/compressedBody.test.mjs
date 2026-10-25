// Cuerpos comprimidos: se rechazan (415) sin tumbar el proceso (GHSA-27r3-jxmh-p828).
import { setupDb, teardownDb } from './helpers.mjs';
import zlib from 'node:zlib';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

describe('Cuerpos comprimidos', () => {
  let server;
  let base;
  before(async () => {
    await setupDb();
    const { createApp } = await import('../src/app.js');
    server = createApp().listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    server.close();
    await teardownDb();
  });

  it('gzip con bytes de sobra → 415 y el servidor sigue vivo', async () => {
    const body = Buffer.concat([zlib.gzipSync('{"email":"a@b.co"}'), Buffer.from('basura-extra')]);
    const r = await fetch(`${base}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body,
    });
    assert.equal(r.status, 415);
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
  });

  it('JSON normal sigue funcionando', async () => {
    const r = await fetch(`${base}/api/plans`);
    assert.equal(r.status, 200);
  });
});
