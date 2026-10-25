// Lector de sitios ("Pruébalo con tu negocio", importar por URL): nunca descomprime
// Brotli de un sitio ajeno (CVE-2026-111497) y no se conecta a IPs internas.
import http from 'node:http';
import zlib from 'node:zlib';
import dns from 'node:dns';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getPage, readSiteText } from '../src/services/siteReader.service.js';

describe('Lector de sitios', () => {
  const html = Buffer.from('<html><title>Hola</title><body>Contenido de prueba</body></html>');
  let srv;
  let base;
  // Solo en la prueba se permite 127.0.0.1 (el lookup real lo bloquea).
  const anyLookup = (h, o, cb) => dns.lookup(h, o, cb);

  before(async () => {
    srv = http.createServer((req, res) => {
      if (req.url === '/br') {
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'br' });
        return res.end(zlib.brotliCompressSync(html));
      }
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      return res.end(zlib.gzipSync(html));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${srv.address().port}`;
  });
  after(() => srv.close());

  it('rechaza respuestas en Brotli sin descomprimirlas', async () => {
    await assert.rejects(getPage(new URL(`${base}/br`), anyLookup), { code: 'BAD_ENCODING' });
  });

  it('lee páginas con gzip', async () => {
    const r = await getPage(new URL(`${base}/gz`), anyLookup);
    assert.equal(r.body.toString(), html.toString());
  });

  it('no se conecta a direcciones internas', async () => {
    await assert.rejects(readSiteText('http://127.0.0.1'), { code: 'BAD_URL' });
    await assert.rejects(getPage(new URL(base)), { code: 'BLOCKED' });
  });
});
