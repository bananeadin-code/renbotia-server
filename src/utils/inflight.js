/**
 * Trabajo en segundo plano que no debe cortarse a la mitad en un deploy: mensajes
 * del webhook (se responde 200 a Meta y se procesa después), cobros de renovación,
 * conciliación… Al recibir SIGTERM, index.js deja de aceptar trabajo nuevo y
 * espera a que esto termine antes de salir.
 */
const pending = new Set();
let closing = false;

/** Registra una promesa en curso y la devuelve tal cual. */
export function track(promise) {
  pending.add(promise);
  promise.finally(() => pending.delete(promise)).catch(() => {});
  return promise;
}

/** true cuando el proceso se está apagando: los programadores no inician rondas nuevas. */
export const isClosing = () => closing;

/**
 * Marca el cierre y espera lo pendiente hasta `timeoutMs`.
 * @returns {Promise<number>} cuántas tareas quedaron sin terminar (0 = todo bien).
 */
export async function drain(timeoutMs) {
  closing = true;
  if (!pending.size) return 0;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([Promise.allSettled([...pending]), timeout]);
  clearTimeout(timer);
  return pending.size;
}
