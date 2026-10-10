// Resume un .cpuprofile: tiempo propio por función y por archivo/paquete.
// Uso: node scripts/loadtest/analyzeProfile.mjs ruta.cpuprofile
import { readFileSync } from 'node:fs';

const prof = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const self = new Map();
const deltas = prof.timeDeltas || [];
prof.samples.forEach((id, i) => self.set(id, (self.get(id) || 0) + (deltas[i] || 0)));
const total = [...self.values()].reduce((a, b) => a + b, 0);

const where = (cf) => {
  const url = cf.url || '';
  if (!url) return cf.functionName ? `(nativo) ${cf.functionName}` : '(nativo)';
  const m = url.match(/node_modules[\\/](@[^\\/]+[\\/][^\\/]+|[^\\/]+)/);
  if (m) return `pkg:${m[1].replace('\\', '/')}`;
  const s = url.match(/server[\\/](src[\\/].*)$/);
  if (s) return s[1].replace(/\\/g, '/');
  if (url.startsWith('node:')) return url;
  return url.split(/[\\/]/).slice(-2).join('/');
};

const byFn = new Map();
const byFile = new Map();
// Tiempo "inclusivo" por archivo propio: cuánto cuelga de código de src/.
for (const [id, t] of self) {
  const n = byId.get(id);
  const cf = n.callFrame;
  const fn = `${cf.functionName || '(anónima)'} — ${where(cf)}:${cf.lineNumber + 1}`;
  byFn.set(fn, (byFn.get(fn) || 0) + t);
  const f = where(cf);
  byFile.set(f, (byFile.get(f) || 0) + t);
}
// Atribución a nuestro código: el primer ancestro que está en src/.
const parent = new Map();
for (const n of prof.nodes) for (const c of n.children || []) parent.set(c, n.id);
const ours = new Map();
for (const [id, t] of self) {
  let cur = id;
  let label = null;
  while (cur != null) {
    const cf = byId.get(cur).callFrame;
    const w = where(cf);
    if (w.startsWith('src/')) {
      label = `${cf.functionName || '(anónima)'} — ${w}:${cf.lineNumber + 1}`;
      break;
    }
    cur = parent.get(cur);
  }
  const k = label || '(fuera de src: idle/GC/librerías sin llamador propio)';
  ours.set(k, (ours.get(k) || 0) + t);
}
const top = (m, n) =>
  [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`)
    .join('\n');
console.log(`Total muestreado: ${(total / 1e6).toFixed(1)} s\n`);
console.log('== Por archivo / paquete (tiempo propio) ==\n' + top(byFile, 25));
console.log('\n== Funciones más costosas (tiempo propio) ==\n' + top(byFn, 30));
console.log('\n== Nuestro código que origina el costo (primer llamador en src/) ==\n' + top(ours, 25));

// Tiempo INCLUSIVO por función de src/ (incluye librerías que llama), sin idle.
const incl = new Map();
for (const [id, t] of self) {
  if (byId.get(id).callFrame.functionName === '(idle)') continue;
  const seen = new Set();
  let cur = id;
  while (cur != null) {
    const cf = byId.get(cur).callFrame;
    const w = where(cf);
    if (w.startsWith('src/')) {
      const k = `${cf.functionName || '(anónima)'} — ${w}:${cf.lineNumber + 1}`;
      if (!seen.has(k)) {
        incl.set(k, (incl.get(k) || 0) + t);
        seen.add(k);
      }
    }
    cur = parent.get(cur);
  }
}
const busy = total - (byFile.get('(nativo) (idle)') || 0);
console.log(`\n== Tiempo inclusivo de nuestro código (% del tiempo OCUPADO: ${(busy / 1e6).toFixed(1)} s) ==`);
console.log(
  [...incl.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([k, v]) => `${((v / busy) * 100).toFixed(1).padStart(5)}%  ${k}`)
    .join('\n')
);
