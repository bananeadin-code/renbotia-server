import { Router } from 'express';
import { requireRecentAuth } from '../middleware/stepUp.middleware.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireBusiness, requireBusinessRole, requireAccess } from '../middleware/tenant.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as members from '../controllers/members.controller.js';

const router = Router();

router.use(requireAuth);

// Aceptar invitación: el invitado puede aún no tener negocio → sin requireBusiness.
router.post('/accept', validate(members.acceptSchema), members.acceptInvitation);

// El resto opera sobre el negocio actual.
router.get('/', requireBusiness, requireAccess('team', 'view'), members.listMembers);
router.post(
  '/invite',
  requireBusiness,
  requireAccess('team', 'edit'),
  requireRecentAuth,
  validate(members.inviteSchema),
  members.inviteMember
);
router.delete('/invite/:id', requireBusiness, requireAccess('team', 'edit'), members.cancelInvitation);
router.delete('/:userId', requireBusiness, requireAccess('team', 'edit'), requireRecentAuth, members.removeMember);
// (Los 4 permisos de antes se retiraron: ahora todo es por rol. Los datos viejos
// se siguen leyendo con legacyAccess, sin migración.)

// Sesiones de cada colaborador en este negocio (el dueño las ve y las cierra).
router.get('/:userId/sessions', requireBusiness, requireAccess('team', 'edit'), members.listMemberSessions);
router.delete('/:userId/sessions', requireBusiness, requireAccess('team', 'edit'), members.closeMemberSessions);
// Rol de cada persona (dueño o administrador; con confirmación de identidad).
router.put(
  '/:userId/role',
  requireBusiness,
  requireAccess('team', 'edit'),
  requireRecentAuth,
  validate(members.memberRoleSchema),
  members.updateMemberRole
);
// Roles personalizados del negocio: solo el dueño los define.
router.post('/roles', requireBusiness, requireBusinessRole('owner'), requireRecentAuth, validate(members.customRoleSchema), members.createCustomRole);
router.put('/roles/:id', requireBusiness, requireBusinessRole('owner'), requireRecentAuth, validate(members.customRoleSchema), members.updateCustomRole);
router.delete('/roles/:id', requireBusiness, requireBusinessRole('owner'), requireRecentAuth, members.deleteCustomRole);
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
