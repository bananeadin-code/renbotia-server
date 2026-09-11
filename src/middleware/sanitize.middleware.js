/**
 * Defensa en profundidad contra inyección NoSQL.
 *
 * Mongoose (casteo por esquema) + Zod (valida como strings) ya bloquean casi
 * todo, pero esto corta de raíz cualquier intento de colar operadores de Mongo
 * en el body/params/query: elimina las claves que empiezan con `$` (operadores
 * como $ne, $gt, $where) o que contienen `.` (rutas tipo "a.b"). Los datos
 * legítimos nunca usan esas claves, así que es seguro.
 */

function scrub(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return;
  for (const key of Object.keys(obj)) {
    if (key.startsWith('$') || key.includes('.')) {
      delete obj[key];
      continue;
    }
    const val = obj[key];
    if (val && typeof val === 'object') scrub(val, depth + 1);
  }
}

export function sanitizeMongo(req, _res, next) {
  scrub(req.body);
  scrub(req.params);
  // req.query puede ser un getter según la versión de Express: saneo defensivo.
  try {
    scrub(req.query);
  } catch {
    /* si no es escribible, lo dejamos: los GET con query van validados aparte */
  }
  next();
}
