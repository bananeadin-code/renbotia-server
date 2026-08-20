import { AuditLog } from '../models/AuditLog.js';
import { logger } from '../utils/logger.js';

/**
 * Registra una acción en la bitácora de auditoría. Fail-open: si falla, se anota
 * en el log pero NUNCA rompe la operación que la disparó. Se usa fire-and-forget.
 *
 * @param {object} p
 * @param {string|import('mongoose').Types.ObjectId} p.businessId
 * @param {string|import('mongoose').Types.ObjectId} [p.userId]
 * @param {string} p.action   Identificador de la acción (ej. 'botconfig.update').
 * @param {string} [p.summary] Descripción legible para mostrar en el panel.
 * @param {object} [p.metadata]
 */
export async function logAudit({ businessId, userId, action, summary = '', metadata = {} }) {
  try {
    if (!businessId || !action) return;
    await AuditLog.create({ business: businessId, user: userId, action, summary, metadata });
  } catch (err) {
    logger.warn(`[audit] No se pudo registrar "${action}": ${err.message}`);
  }
}
