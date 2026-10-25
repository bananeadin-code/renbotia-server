import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

/**
 * Lee el texto de una página pública para la demo "Pruébalo con tu negocio".
 *
 * Protección SSRF: solo http(s) a puertos 80/443, el host debe resolver a IPs
 * PÚBLICAS (se rechazan loopback, redes privadas, link-local, metadatos de nube,
 * etc.) y cada redirección se vuelve a validar. Tiempo y tamaño acotados.
 */

const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;
const MAX_TEXT = 12000;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  if (v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80')) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  return mapped ? isPrivateIp(mapped[1]) : false;
}

async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error('El enlace no es válido.'), { code: 'BAD_URL' });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw Object.assign(new Error('Usa un enlace que empiece con http o https.'), { code: 'BAD_URL' });
  }
  if (url.port && !['80', '443'].includes(url.port)) {
    throw Object.assign(new Error('Ese enlace no se puede leer.'), { code: 'BAD_URL' });
  }
  if (url.username || url.password) {
    throw Object.assign(new Error('Ese enlace no se puede leer.'), { code: 'BAD_URL' });
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw Object.assign(new Error('No encontramos ese sitio. Revisa el enlace.'), { code: 'NOT_FOUND' });
  if (addrs.some((a) => isPrivateIp(a.address))) {
    throw Object.assign(new Error('Ese enlace no se puede leer.'), { code: 'BAD_URL' });
  }
  return url;
}

/** Texto visible aproximado de un HTML (título, descripción y cuerpo). */
export function htmlToText(html) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '';
  const desc =
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1] ||
    /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1] ||
    '';
  const body = html
    .replace(/<(head|script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|br|tr|section|article|footer|header)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const decode = (s) =>
    s
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  const text = decode(`${title}\n${desc}\n${body}`)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 1)
    .join('\n');
  return text.slice(0, MAX_TEXT);
}

/**
 * Lookup de DNS que valida la IP AL CONECTAR (no solo antes): evita el "DNS
 * rebinding", donde el dominio resuelve a una IP pública en la revisión y a una
 * privada justo después.
 */
function publicLookup(hostname, options, callback) {
  dns
    .lookup(hostname, { all: true })
    .then((addrs) => {
      if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
        return callback(Object.assign(new Error('Destino no permitido'), { code: 'BLOCKED' }));
      }
      if (options?.all) return callback(null, addrs);
      return callback(null, addrs[0].address, addrs[0].family);
    })
    .catch((err) => callback(err));
}

/**
 * GET con el cliente nativo (sin fetch): pide la página SIN compresión y solo
 * acepta identity/gzip/deflate. Nunca se descomprime Brotli de un sitio ajeno
 * (CVE-2026-111497: el decodificador Brotli de Node permitía ejecución remota).
 * Devuelve el cuerpo ya acotado por tamaño y tiempo.
 */
export function getPage(url, lookup = publicLookup) {
  return new Promise((resolve, reject) => {
    // Con una IP literal Node no llama al lookup: se valida aquí también.
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (lookup === publicLookup && net.isIP(host) && isPrivateIp(host)) {
      return reject(Object.assign(new Error('Destino no permitido'), { code: 'BLOCKED' }));
    }
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      {
        method: 'GET',
        lookup,
        headers: {
          'User-Agent': 'RenBotIA-Demo/1.0 (+https://renbotia.com)',
          Accept: 'text/html,*/*;q=0.5',
          'Accept-Encoding': 'gzip, deflate, identity;q=0.5',
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        const headers = res.headers;
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, headers, body: Buffer.alloc(0) });
        }
        const enc = String(headers['content-encoding'] || 'identity').toLowerCase().trim();
        let stream = res;
        if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc !== 'identity' && enc !== '') {
          res.destroy();
          return reject(Object.assign(new Error('Codificación no soportada'), { code: 'BAD_ENCODING' }));
        }
        const chunks = [];
        let size = 0;
        const done = () => resolve({ status, headers, body: Buffer.concat(chunks) });
        stream.on('data', (c) => {
          size += c.length;
          chunks.push(c);
          if (size > MAX_BYTES) {
            res.destroy();
            done(); // se usa lo leído
          }
        });
        stream.on('end', done);
        stream.on('error', () => done()); // corte por tamaño o red: se usa lo leído
      }
    );
    req.setTimeout(TIMEOUT_MS, () => req.destroy(Object.assign(new Error('Tiempo agotado'), { code: 'TIMEOUT' })));
    req.on('error', reject);
    req.end();
  });
}

/** Texto según el charset de la página (cabecera o <meta charset>); UTF-8 por defecto. */
function decodeBody(buf, contentType) {
  const head = buf.subarray(0, 2048).toString('latin1');
  const label =
    /charset=["']?([\w-]+)/i.exec(contentType)?.[1] || /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] || 'utf-8';
  try {
    return new TextDecoder(label).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/**
 * Descarga una página pública y devuelve su texto.
 * @returns {Promise<{ url: string, text: string }>}
 */
export async function readSiteText(rawUrl) {
  let current = /^https?:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertPublicUrl(current);
    let res;
    try {
      res = await getPage(url);
    } catch {
      throw Object.assign(new Error('No pudimos abrir tu sitio. Revisa el enlace o descríbenos tu negocio.'), {
        code: 'FETCH_FAILED',
      });
    }
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      current = new URL(res.headers.location, url).toString();
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      throw Object.assign(new Error('Tu sitio no respondió. Prueba describiendo tu negocio.'), { code: 'FETCH_FAILED' });
    }
    const type = String(res.headers['content-type'] || '');
    if (!/text\/html|application\/xhtml/i.test(type)) {
      throw Object.assign(new Error('Ese enlace no es una página web.'), { code: 'NOT_HTML' });
    }
    return { url: url.toString(), text: htmlToText(decodeBody(res.body, type)) };
  }
  throw Object.assign(new Error('Tu sitio redirige demasiadas veces.'), { code: 'FETCH_FAILED' });
}
