import { Router } from 'express';
import { requireRecentAuth } from '../middleware/stepUp.middleware.js';
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
  requireRecentAuth,
  validate(members.inviteSchema),
  members.inviteMember
);
router.delete('/invite/:id', requireBusiness, requireBusinessRole('owner'), members.cancelInvitation);
router.delete('/:userId', requireBusiness, requireBusinessRole('owner'), requireRecentAuth, members.removeMember);
router.patch(
  '/:userId/permissions',
  requireBusiness,
  requireBusinessRole('owner'),
  requireRecentAuth,
  validate(members.permissionsSchema),
  members.updatePermissions
);

// Sesiones de cada colaborador en este negocio (el dueño las ve y las cierra).
router.get('/:userId/sessions', requireBusiness, requireBusinessRole('owner'), members.listMemberSessions);
router.delete('/:userId/sessions', requireBusiness, requireBusinessRole('owner'), members.closeMemberSessions);
// Seguridad del equipo: exigir verificación en dos pasos a los colaboradores.
router.put(
  '/security',
  requireBusiness,
  requireBusinessRole('owner'),
  requireRecentAuth,
  validate(members.teamSecuritySchema),
  members.updateTeamSecurity
);

export default router;
