import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireRole, requireAdmin } from '../middleware/role.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { ROLES } from '../config/constants.js';
import * as funnel from '../controllers/funnel.controller.js';

/**
 * Embudo comercial / CRM. Equipo de RenBotIA (admin + soporte): seguimiento de
 * registros. Solo admin: resumen con dinero, inversión y reporte.
 */
const router = Router();
router.use(requireAuth, requireRole(ROLES.ADMIN, ROLES.SOPORTE));

router.get('/leads', funnel.getLeads);
router.get('/staff', funnel.getStaff);
router.patch('/leads/:userId', validate(funnel.updateLeadSchema), funnel.updateLead);
router.post('/leads/:userId/notes', validate(funnel.noteSchema), funnel.addNote);

router.get('/summary', requireAdmin, funnel.getSummary);
router.get('/spend', requireAdmin, funnel.getSpend);
router.put('/spend', requireAdmin, validate(funnel.spendSchema), funnel.putSpend);
router.post('/report', requireAdmin, funnel.sendReportNow);

export default router;
