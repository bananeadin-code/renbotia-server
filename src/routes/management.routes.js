import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireBusiness } from '../middleware/tenant.middleware.js';
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
} from '../controllers/management.controller.js';

/**
 * Módulo de Gestión (solo Elite). El cliente ve y gestiona el trabajo que capta
 * el bot (citas, reservaciones, pedidos, prospectos) y define su disponibilidad.
 */
const router = Router();

// Todo el módulo requiere sesión + negocio + plan Elite.
router.use(requireAuth, requireBusiness, requireElite);

router.get('/config', getConfig);
router.put('/config', validate(updateConfigSchema), putConfig);

router.get('/availability', availabilityHandler);
router.get('/stats', statsHandler);

router.get('/records', listRecordsHandler);
router.post('/records', validate(createRecordSchema), createRecordHandler);
router.patch('/records/:id', validate(updateRecordSchema), updateRecordHandler);
router.delete('/records/:id', deleteRecordHandler);

export default router;
