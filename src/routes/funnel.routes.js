import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireRole, requireAdmin } from '../middleware/role.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { ROLES } from '../config/constants.js';
import * as funnel from '../controllers/funnel.controller.js';

/**
 * Embudo comercial / CRM.
 *  - Agencia de marketing (y admin): resultados de campañas pagadas, sin datos
 *    personales; captura de su inversión; conversiones para Google Ads.
 *  - Equipo de RenBotIA (admin + soporte): seguimiento de registros.
 *  - Solo admin: resumen con dinero de todos los canales, inversión y reporte.
 */
const router = Router();

const agency = [requireAuth, requireRole(ROLES.ADMIN, ROLES.AGENCIA)];
router.get('/campaigns', ...agency, funnel.getCampaigns);
router.get('/campaign-spend', ...agency, funnel.getCampaignSpend);
router.put('/campaign-spend', ...agency, validate(funnel.campaignSpendSchema), funnel.putCampaignSpend);
router.get('/offline-conversions.csv', ...agency, funnel.getOfflineConversions);

const team = [requireAuth, requireRole(ROLES.ADMIN, ROLES.SOPORTE)];
router.get('/leads', ...team, funnel.getLeads);
router.get('/staff', ...team, funnel.getStaff);
router.patch('/leads/:userId', ...team, validate(funnel.updateLeadSchema), funnel.updateLead);
router.post('/leads/:userId/notes', ...team, validate(funnel.noteSchema), funnel.addNote);

router.get('/summary', ...team, requireAdmin, funnel.getSummary);
router.get('/spend', ...team, requireAdmin, funnel.getSpend);
router.put('/spend', ...team, requireAdmin, validate(funnel.spendSchema), funnel.putSpend);
router.post('/report', ...team, requireAdmin, funnel.sendReportNow);

export default router;
