import { Router } from 'express';
import { listPlans } from '../controllers/plan.controller.js';

const router = Router();

// Público: precios y paquetes de créditos
router.get('/', listPlans);

export default router;
