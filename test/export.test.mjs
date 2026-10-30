// Exportaciones a Excel: archivo .xlsx válido con teléfonos legibles y sin fórmulas.
import zlib from 'node:zlib';
import { setupDb, teardownDb, makeOwner } from './helpers.mjs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

/** Lee un archivo del ZIP (cabeceras locales en orden, como las escribe utils/xlsx). */
function unzipFile(buf, wanted) {
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const csize = buf.readUInt32LE(i + 18);
    const nlen = buf.readUInt16LE(i + 26);
    const elen = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nlen).toString('utf8');
    const start = i + 30 + nlen + elen;
    if (name === wanted) return zlib.inflateRawSync(buf.subarray(start, start + csize)).toString('utf8');
    i = start + csize;
  }
  return null;
}

describe('Exportar a Excel', () => {
  let srv, A, startSession, ChatSimulation;
  before(async () => {
    await setupDb();
    ({ startSession } = await import('../src/services/session.service.js'));
    ({ ChatSimulation } = await import('../src/models/ChatSimulation.js'));
    const { createApp } = await import('../src/app.js');
    srv = createApp().listen(0);
    A = `http://127.0.0.1:${srv.address().port}/api`;
  });
  after(async () => {
    srv?.close();
    await teardownDb();
  });

  it('conversaciones: xlsx con teléfono legible, conteo y texto que no se ejecuta', async () => {
    const o = await makeOwner('Export');
    const { accessToken: T } = await startSession({ user: o.user, silent: true, context: { kind: 'owner', business: o.business._id } });
    await ChatSimulation.create({
      business: o.business._id,
      channel: 'whatsapp',
      customerPhone: '5216181234567',
      customerName: 'Ana & Co',
      messages: [
        { role: 'user', content: 'Hola', timestamp: new Date() },
        { role: 'assistant', content: '=HYPERLINK("http://x")', via: 'bot', timestamp: new Date() },
      ],
    });
    const r = await fetch(`${A}/conversations/export`, { headers: { Authorization: `Bearer ${T}` } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /spreadsheetml/);
    assert.match(r.headers.get('content-disposition'), /conversaciones-renbotia\.xlsx/);
    const sheet = unzipFile(Buffer.from(await r.arrayBuffer()), 'xl/worksheets/sheet1.xml');
    assert.ok(sheet, 'la hoja existe');
    assert.match(sheet, /\+52 618 123 4567/);
    assert.match(sheet, /WhatsApp/);
    assert.match(sheet, /Ana &amp; Co/);
    assert.match(sheet, /<v>2<\/v>/, 'conteo de mensajes como número');
    assert.doesNotMatch(sheet, /<f>/, 'nunca hay fórmulas');
  });
});
