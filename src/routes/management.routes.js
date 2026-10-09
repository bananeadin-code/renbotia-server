import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireBusiness, requireAccess } from '../middleware/tenant.middleware.js';
import { requireElite } from '../middleware/plan.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import {
  getConfig,
  putConfig,
  updateConfigSchema,
  listRecordsHandler,
  createRecordHandler,
  createRecordSchema,
  updateRecordHandler,
  updateRecordSchema,
  deleteRecordHandler,
  availabilityHandler,
  statsHandler,
  exportRecords,
} from '../controllers/management.controller.js';

/**
 * Módulo de Gestión (solo Elite). El cliente ve y gestiona el trabajo que capta
 * el bot (citas, reservaciones, pedidos, prospectos) y define su disponibilidad.
 */
const router = Router();

// Todo el módulo requiere sesión + negocio + plan Elite.
router.use(requireAuth, requireBusiness, requireElite);

router.get('/config', requireAccess('management', 'view'), getConfig);
router.put('/config', requireAccess('management', 'edit'), validate(updateConfigSchema), putConfig);

router.get('/availability', requireAccess('management', 'view'), availabilityHandler);
router.get('/stats', requireAccess('management', 'view'), statsHandler);

router.get('/export', requireAccess('management', 'view'), exportRecords);
router.get('/records', requireAccess('management', 'view'), listRecordsHandler);
router.post('/records', requireAccess('management', 'edit'), validate(createRecordSchema), createRecordHandler);
router.patch('/records/:id', requireAccess('management', 'edit'), validate(updateRecordSchema), updateRecordHandler);
router.delete('/records/:id', requireAccess('management', 'edit'), deleteRecordHandler);

export default router;
