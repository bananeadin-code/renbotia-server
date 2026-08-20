import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireBusiness, requireBusinessRole } from '../middleware/tenant.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as members from '../controllers/members.controller.js';

const router = Router();

router.use(requireAuth);

// Aceptar invitación: el invitado puede aún no tener negocio → sin requireBusiness.
router.post('/accept', validate(members.acceptSchema), members.acceptInvitation);

// El resto opera sobre el negocio actual.
router.get('/', requireBusiness, members.listMembers);
router.post(
  '/invite',
  requireBusiness,
  requireBusinessRole('owner'),
  validate(members.inviteSchema),
  members.inviteMember
);
router.delete('/invite/:id', requireBusiness, requireBusinessRole('owner'), members.cancelInvitation);
router.delete('/:userId', requireBusiness, requireBusinessRole('owner'), members.removeMember);

export default router;
