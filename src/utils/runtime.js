import { logger } from './logger.js';
import { alertOps } from '../services/alert.service.js';

/**
 * Versión mínima PARCHADA de cada línea de Node (actualizar con cada aviso de
 * seguridad de nodejs.org). Octubre 2026: CVE-2026-111497 (Brotli, ejecución
 * remota) y otras 9 → 22.23.4 / 24.22.1 / 26.12.1. Líneas fuera de la lista
 * (impares o fin de soporte) no reciben parches.
 */
export const PATCHED_NODE = { 22: [22, 23, 4], 24: [24, 22, 1], 26: [26, 12, 1] };

/** ¿Esta versión de Node ("v24.22.1") tiene los parches de seguridad vigentes? */
export function isPatchedNode(version = process.version) {
  const v = String(version).replace(/^v/, '').split('.').map(Number);
  const min = PATCHED_NODE[v[0]];
  if (!min) return false;
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
}

/** Al arrancar: registra la versión y avisa (log + correo) si está sin parchar. */
export function checkNodeRuntime() {
  if (isPatchedNode()) {
    logger.info(`Node ${process.version} (con parches de seguridad vigentes).`);
    return true;
  }
  const message = `Node ${process.version} NO tiene los parches de seguridad vigentes (mínimos: 22.23.4, 24.22.1 o 26.12.1). Redespliega con una versión parchada.`;
  logger.error(message);
  alertOps({ kind: 'node_unpatched', message });
  return false;
}
