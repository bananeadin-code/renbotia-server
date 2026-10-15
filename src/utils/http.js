/**
 * fetch con tiempo límite. Node no corta solo una petición colgada: sin esto, una
 * API externa lenta (Meta) dejaría mensajes esperando y acumulándose en memoria.
 */
export const EXTERNAL_TIMEOUT_MS = 20_000;

export function fetchWithTimeout(url, init = {}, timeoutMs = EXTERNAL_TIMEOUT_MS) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs), ...init });
}
