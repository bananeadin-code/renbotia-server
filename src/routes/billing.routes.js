import { Router } from 'express';
import { requireRecentAuth } from '../middleware/stepUp.middleware.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireBusiness, requireBusinessRole } from '../middleware/tenant.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as billing from '../controllers/billing.controller.js';

const router = Router();

// PÚBLICO (sin auth): estado de disponibilidad de planes, para la página de Precios.
router.get('/public-config', billing.getPublicBillingConfig);

// Solo el DUEÑO gestiona pagos/plan (los colaboradores no tocan facturación).
const ownerOnly = [requireBusiness, requireBusinessRole('owner')];

// Pago embebido de un PLAN y confirmación: solo requieren sesión (el negocio
// puede no existir todavía en el onboarding). El validador de /intent decide
// si necesita negocio según el tipo (créditos sí, plan no necesariamente).
router.post('/intent', requireAuth, ...ownerOnly, requireRecentAuth, validate(billing.createIntentSchema), billing.createIntent);
router.post('/confirm', requireAuth, ...ownerOnly, validate(billing.confirmSchema), billing.confirmCheckout);

// Historial y estado: cualquier miembro del negocio puede ver.
router.get('/payments', requireAuth, requireBusiness, billing.listPayments);
router.get('/config', requireAuth, billing.getBillingConfig); // clave publicable
router.get('/payment-method', requireAuth, requireBusiness, billing.getPaymentMethod);

// Mutaciones de plan/pago: SOLO dueño.
router.post('/cancel', requireAuth, ...ownerOnly, billing.cancelSubscription);
router.post('/resume', requireAuth, ...ownerOnly, billing.resumeSubscription);
router.post('/change-plan', requireAuth, ...ownerOnly, validate(billing.changePlanSchema), billing.changePlan);
router.post('/setup-intent', requireAuth, ...ownerOnly, requireRecentAuth, billing.startSetupIntent);
router.post(
  '/payment-method',
  requireAuth,
  ...ownerOnly,
  requireRecentAuth,
  validate(billing.savePaymentMethodSchema),
  billing.savePaymentMethod
);
router.delete('/payment-method', requireAuth, ...ownerOnly, requireRecentAuth, billing.deletePaymentMethod);
router.put('/auto-recharge', requireAuth, ...ownerOnly, requireRecentAuth, validate(billing.autoRechargeSchema), billing.updateAutoRecharge);

export default router;
