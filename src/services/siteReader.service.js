import dns from 'node:dns/promises';
import net from 'node:net';

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
 * Descarga una página pública y devuelve su texto.
 * @returns {Promise<{ url: string, text: string }>}
 */
export async function readSiteText(rawUrl) {
  let current = /^https?:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertPublicUrl(current);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'User-Agent': 'RenBotIA-Demo/1.0 (+https://renbotia.com)', Accept: 'text/html,*/*;q=0.5' },
      });
    } catch {
      clearTimeout(timer);
      throw Object.assign(new Error('No pudimos abrir tu sitio. Revisa el enlace o descríbenos tu negocio.'), {
        code: 'FETCH_FAILED',
      });
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      clearTimeout(timer);
      current = new URL(res.headers.get('location'), url).toString();
      continue;
    }
    if (!res.ok) {
      clearTimeout(timer);
      throw Object.assign(new Error('Tu sitio no respondió. Prueba describiendo tu negocio.'), { code: 'FETCH_FAILED' });
    }
    const type = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(type)) {
      clearTimeout(timer);
      throw Object.assign(new Error('Ese enlace no es una página web.'), { code: 'NOT_HTML' });
    }
    // Lectura acotada por tamaño.
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        chunks.push(value);
        if (size > MAX_BYTES) {
          ctrl.abort();
          break;
        }
      }
    } catch {
      /* corte por tamaño o tiempo: se usa lo leído */
    } finally {
      clearTimeout(timer);
    }
    const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
    return { url: url.toString(), text: htmlToText(html) };
  }
  throw Object.assign(new Error('Tu sitio redirige demasiadas veces.'), { code: 'FETCH_FAILED' });
}
