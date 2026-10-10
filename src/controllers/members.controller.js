import crypto from 'crypto';
import { MODULES, MODULE_LEVELS, CHANNELS, PRESET_ROLES, normalizeModules, normalizeChannels, resolveAccess, can } from '../config/access.js';
import { listMemberSessions as listMemberSessionsSvc, revokeMemberSessions } from '../services/session.service.js';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { Membership } from '../models/Membership.js';
import { Invitation } from '../models/Invitation.js';
import { Business } from '../models/Business.js';
import { User } from '../models/User.js';
import { Subscription } from '../models/Subscription.js';
import { sendEmail } from '../services/email.service.js';
import { logAudit } from '../services/audit.service.js';
import { env, isProd } from '../config/env.js';
import { UsageLog } from '../models/UsageLog.js';
import { PERMISSION_KEYS, DEFAULT_MEMBER_PERMISSIONS } from '../config/constants.js';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días
const acceptLink = (token) => `${env.publicUrl.replace(/\/$/, '')}/aceptar-invitacion?token=${token}`;

/**
 * GET /api/members
 * Lista los miembros del negocio (con rol) y las invitaciones pendientes.
 * Cualquier miembro puede ver; solo el dueño gestiona.
 */
export const listMembers = asyncHandler(async (req, res) => {
  const [memberships, invitations] = await Promise.all([
    Membership.find({ business: req.businessId }).populate('user', 'name email').sort({ createdAt: 1 }).lean(),
    Invitation.find({ business: req.businessId }).sort({ createdAt: 1 }).lean(),
  ]);

  // Gasto del simulador por persona este mes (control del equipo).
  const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const simAgg = await UsageLog.aggregate([
    { $match: { business: req.businessId, source: 'simulator', user: { $ne: null }, date: { $gte: startOfMonth } } },
    { $group: { _id: '$user', tokens: { $sum: '$totalTokens' }, messages: { $sum: 1 } } },
  ]);
  const simBy = Object.fromEntries(simAgg.map((g) => [String(g._id), g]));

  const members = memberships
    .filter((m) => m.user)
    .map((m) => ({
      userId: m.user._id,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      isMe: String(m.user._id) === String(req.userId),
      permissions:
        m.role === 'owner'
          ? Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true]))
          : { ...DEFAULT_MEMBER_PERMISSIONS, ...(m.permissions || {}) },
      // IAM: rol y acceso efectivo (módulos y canales).
      access: resolveAccess(m, req.business),
      simulator: {
        tokens: simBy[String(m.user._id)]?.tokens || 0,
        messages: simBy[String(m.user._id)]?.messages || 0,
      },
    }));

  res.json({
    success: true,
    data: {
      myRole: req.membershipRole,
      myAccess: req.access,
      canManageTeam: can(req.access, 'team', 'edit'),
      roles: rolesCatalog(req.business),
      members,
      security: { requireTeam2fa: Boolean(req.business?.security?.requireTeam2fa) },
      invitations: invitations.map((i) => ({
        id: i._id,
        email: i.email,
        role: i.role,
        roleKey: i.roleKey || 'agent',
        roleName: roleNameOf(i.roleKey || 'agent', req.business),
        expiresAt: i.expiresAt,
      })),
    },
  });
});

export const inviteSchema = z.object({
  email: z.string().email('Correo inválido'),
  // Rol con el que entrará (por defecto, Agente de ventas).
  roleKey: z.string().max(40).optional().default('agent'),
});

/**
 * POST /api/members/invite  (solo dueño)
 * Invita a un colaborador por email. Crea la invitación y "envía" el enlace.
 * En desarrollo devuelve el enlace (devLink) para probar sin correo real.
 */
export const inviteMember = asyncHandler(async (req, res) => {
  // Gating de plan: invitar colaboradores es solo Pro/Elite (Free = solo el dueño).
  const sub = await Subscription.findOne({ business: req.businessId }).populate('plan', 'key');
  if (!['pro', 'elite'].includes(sub?.plan?.key)) {
    throw new ApiError(403, 'Invitar colaboradores está disponible en los planes Pro y Elite.', {
      code: 'PLAN_REQUIRED',
      requiredPlans: ['pro', 'elite'],
    });
  }

  const email = req.body.email.trim().toLowerCase();

  const owner = await User.findById(req.userId).select('email');
  if (owner?.email?.toLowerCase() === email) {
    throw ApiError.badRequest('Ya eres parte de este negocio.');
  }

  // ¿Ya es miembro? (usuario existente con membresía)
  const existingUser = await User.findOne({ email }).select('_id');
  if (existingUser) {
    const already = await Membership.findOne({ business: req.businessId, user: existingUser._id });
    if (already) throw ApiError.badRequest('Esa persona ya es miembro del negocio.');
  }

  const token = crypto.randomBytes(24).toString('hex');
  const invitation = await Invitation.findOneAndUpdate(
    { business: req.businessId, email },
    {
      business: req.businessId,
      email,
      role: 'colaborador',
      roleKey: validRoleKey(req.body.roleKey, req.business) ? req.body.roleKey : 'agent',
      token,
      invitedBy: req.userId,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const link = acceptLink(invitation.token);
  void sendEmail({
    to: email,
    subject: `Te invitaron a colaborar en ${req.business?.name || 'un negocio'} en RenBotIA`,
    html: `<p>Te invitaron a ayudar a configurar el bot de WhatsApp de <b>${escapeHtml(req.business?.name || 'un negocio')}</b> en RenBotIA.</p>
           <p><a href="${link}">Aceptar invitación</a> (vence en 7 días).</p>
           <p>Si no tienes cuenta, crea una con este mismo correo (${escapeHtml(email)}) y luego abre el enlace.</p>`,
  });

  void logAudit({
    businessId: req.businessId,
    userId: req.userId,
    action: 'member.invite',
    summary: `Invitó a ${email} como colaborador.`,
  });

  // Informamos a la UI si la persona YA tiene cuenta (para el mensaje correcto:
  // "le enviamos el enlace" vs "debe crear una cuenta con este correo").
  const registered = Boolean(existingUser);
  const data = { email: invitation.email, registered };
  if (!isProd) data.devLink = link; // en dev, para probar sin correo real
  res.status(201).json({
    success: true,
    message: registered
      ? 'Invitación enviada. La persona ya tiene cuenta; abrirá el enlace para unirse.'
      : 'Invitación enviada. La persona debe crear una cuenta con ese correo y luego abrir el enlace.',
    data,
  });
});

export const acceptSchema = z.object({ token: z.string().min(10) });

/**
 * POST /api/members/accept  (auth, sin requireBusiness: el invitado puede no
 * tener negocio aún). Valida que el correo del usuario coincide con el invitado.
 */
export const acceptInvitation = asyncHandler(async (req, res) => {
  const invitation = await Invitation.findOne({ token: req.body.token });
  if (!invitation) throw ApiError.badRequest('La invitación no existe o ya fue usada.');
  if (Date.now() > new Date(invitation.expiresAt).getTime()) {
    await invitation.deleteOne();
    throw ApiError.badRequest('La invitación venció. Pide una nueva.');
  }

  const user = await User.findById(req.userId).select('email name');
  if (user?.email?.toLowerCase() !== invitation.email.toLowerCase()) {
    throw ApiError.forbidden('Esta invitación es para otro correo. Inicia sesión con el correo invitado.');
  }

  // Tope de proyectos: además del propio, se puede colaborar en UNO más (máx. 2).
  const alreadyMember = await Membership.findOne({
    business: invitation.business,
    user: req.userId,
  });
  if (!alreadyMember) {
    const otherCollab = await Membership.findOne({
      user: req.userId,
      role: 'colaborador',
      business: { $ne: invitation.business },
    });
    if (otherCollab) {
      throw ApiError.badRequest(
        'Solo puedes colaborar en un proyecto además del tuyo. Sal del otro para unirte a este.'
      );
    }
  }

  await Membership.updateOne(
    { business: invitation.business, user: req.userId },
    { $setOnInsert: { role: invitation.role, roleKey: invitation.roleKey || 'agent' } },
    { upsert: true }
  );
  await invitation.deleteOne();

  const business = await Business.findById(invitation.business).select('name');
  void logAudit({
    businessId: invitation.business,
    userId: req.userId,
    action: 'member.accept',
    summary: `${user?.name || user?.email} aceptó la invitación como colaborador.`,
  });

  res.json({ success: true, message: 'Te uniste al negocio.', data: { businessName: business?.name } });
});

/**
 * DELETE /api/members/invite/:id  (solo dueño) — cancela una invitación pendiente.
 */
export const cancelInvitation = asyncHandler(async (req, res) => {
  await Invitation.deleteOne({ _id: req.params.id, business: req.businessId });
  res.json({ success: true, message: 'Invitación cancelada.' });
});

/**
 * DELETE /api/members/:userId  (solo dueño) — quita a un colaborador. No se puede
 * quitar a un dueño ni a uno mismo por esta vía.
 */
export const removeMember = asyncHandler(async (req, res) => {
  const target = await Membership.findOne({ business: req.businessId, user: req.params.userId });
  if (!target) throw ApiError.notFound('Ese miembro no existe.');
  if (target.role === 'owner') throw ApiError.badRequest('No puedes quitar al dueño del negocio.');

  await target.deleteOne();
  // Sus sesiones en este negocio se cierran de inmediato.
  await revokeMemberSessions(req.businessId, { userId: req.params.userId, reason: 'removed' });
  void logAudit({
    businessId: req.businessId,
    userId: req.userId,
    action: 'member.remove',
    summary: `Quitó a un colaborador del negocio.`,
    metadata: { removedUserId: String(req.params.userId) },
  });
  res.json({ success: true, message: 'Colaborador removido.' });
});

function escapeHtml(str = '') {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** GET /api/members/:userId/sessions — sesiones abiertas del colaborador en este negocio. */
export const listMemberSessions = asyncHandler(async (req, res) => {
  const m = await Membership.findOne({ business: req.businessId, user: req.params.userId }).select('role').lean();
  if (!m || m.role === 'owner') throw ApiError.notFound('Ese colaborador no existe.');
  res.json({ success: true, data: { sessions: await listMemberSessionsSvc(req.businessId, req.params.userId) } });
});

/** DELETE /api/members/:userId/sessions — cierra sus sesiones en este negocio. */
export const closeMemberSessions = asyncHandler(async (req, res) => {
  const m = await Membership.findOne({ business: req.businessId, user: req.params.userId }).select('role').lean();
  if (!m || m.role === 'owner') throw ApiError.notFound('Ese colaborador no existe.');
  const closed = await revokeMemberSessions(req.businessId, { userId: req.params.userId, reason: 'owner' });
  void logAudit({
    businessId: req.businessId,
    userId: req.userId,
    action: 'member.sessions',
    summary: `Cerró ${closed} ${closed === 1 ? 'sesión' : 'sesiones'} de un colaborador.`,
    metadata: { memberUserId: String(req.params.userId) },
  });
  res.json({ success: true, data: { closed } });
});

export const teamSecuritySchema = z.object({ requireTeam2fa: z.boolean() });

/**
 * PUT /api/members/security — exigir verificación en dos pasos a los
 * colaboradores. Al activarlo se cierran las sesiones de quien no la verificó
 * (tendrán que entrar de nuevo con un código).
 */
export const updateTeamSecurity = asyncHandler(async (req, res) => {
  const on = req.body.requireTeam2fa;
  await Business.updateOne({ _id: req.businessId }, { $set: { 'security.requireTeam2fa': on } });
  const closed = on ? await revokeMemberSessions(req.businessId, { onlyWithoutMfa: true, reason: 'team_2fa' }) : 0;
  void logAudit({
    businessId: req.businessId,
    userId: req.userId,
    action: 'team.security',
    summary: on ? 'Exigió verificación en dos pasos a todo el equipo.' : 'Dejó de exigir verificación en dos pasos al equipo.',
  });
  res.json({ success: true, data: { requireTeam2fa: on, closed } });
});

/* ── IAM: roles del equipo ─────────────────────────────────────────────── */

const levelEnum = z.enum(['none', 'view', 'edit']);
const modulesSchema = z.object(Object.fromEntries(MODULES.map((m) => [m, levelEnum.optional()])));
const channelsSchema = z.union([z.literal('all'), z.array(z.enum(CHANNELS)).max(CHANNELS.length)]);

function validRoleKey(key, business) {
  if (PRESET_ROLES[key]) return true;
  if (String(key || '').startsWith('role:')) {
    const id = key.slice(5);
    return (business?.customRoles || []).some((r) => String(r._id) === id);
  }
  return false;
}

function roleNameOf(key, business) {
  if (PRESET_ROLES[key]) return PRESET_ROLES[key].name;
  if (String(key || '').startsWith('role:')) {
    return (business?.customRoles || []).find((r) => String(r._id) === key.slice(5))?.name || 'Rol eliminado';
  }
  return key === 'custom' ? 'Personalizado' : 'Colaborador';
}

/** Roles disponibles para asignar (listos + personalizados del negocio). */
function rolesCatalog(business) {
  return {
    modules: MODULES,
    moduleLevels: MODULE_LEVELS,
    channels: CHANNELS,
    presets: Object.entries(PRESET_ROLES).map(([key, r]) => ({
      key,
      name: r.name,
      description: r.description,
      modules: normalizeModules(r.modules),
      channels: normalizeChannels(r.channels),
    })),
    custom: (business?.customRoles || []).map((r) => ({
      key: `role:${r._id}`,
      id: String(r._id),
      name: r.name,
      modules: normalizeModules(r.modules),
      channels: normalizeChannels(r.channels),
    })),
  };
}

export const memberRoleSchema = z
  .object({
    roleKey: z.string().max(40),
    access: z.object({ modules: modulesSchema, channels: channelsSchema }).optional(),
  })
  .refine((d) => d.roleKey !== 'custom' || d.access, { message: 'Falta el acceso personalizado.', path: ['access'] });

/**
 * PUT /api/members/:userId/role — asigna un rol (o acceso personalizado).
 * Lo hace quien tiene "equipo: editar" (dueño o administrador). Nadie cambia su
 * propio rol ni el del dueño.
 */
export const updateMemberRole = asyncHandler(async (req, res) => {
  const m = await Membership.findOne({ business: req.businessId, user: req.params.userId });
  if (!m) throw ApiError.notFound('Ese miembro no existe.');
  if (m.role === 'owner') throw ApiError.badRequest('El dueño siempre tiene todo.');
  if (String(req.params.userId) === String(req.userId)) {
    throw ApiError.badRequest('No puedes cambiar tu propio rol. Pídeselo al dueño.');
  }
  const { roleKey, access } = req.body;
  if (roleKey === 'custom') {
    m.roleKey = 'custom';
    m.access = { modules: normalizeModules(access.modules), channels: normalizeChannels(access.channels) };
  } else {
    if (!validRoleKey(roleKey, req.business)) throw ApiError.badRequest('Ese rol no existe.');
    m.roleKey = roleKey;
    m.access = undefined;
  }
  await m.save();
  const user = await User.findById(req.params.userId).select('name email').lean();
  void logAudit({
    businessId: req.businessId,
    userId: req.userId,
    action: 'member.role',
    summary: `Asignó el rol ${roleNameOf(roleKey, req.business)} a ${user?.name || user?.email || 'un colaborador'}.`,
  });
  res.json({ success: true, data: { access: resolveAccess(m.toObject(), req.business) } });
});

export const customRoleSchema = z.object({
  name: z.string().trim().min(2, 'Ponle nombre al rol').max(40),
  modules: modulesSchema,
  channels: channelsSchema.optional().default('all'),
});

/** POST /api/members/roles — crea un rol personalizado (solo dueño, máx. 10). */
export const createCustomRole = asyncHandler(async (req, res) => {
  const business = await Business.findById(req.businessId);
  if ((business.customRoles || []).length >= 10) throw ApiError.badRequest('Llegaste al máximo de 10 roles.');
  if ((business.customRoles || []).some((r) => r.name.toLowerCase() === req.body.name.toLowerCase())) {
    throw ApiError.badRequest('Ya tienes un rol con ese nombre.');
  }
  business.customRoles.push({
    name: req.body.name,
    modules: normalizeModules(req.body.modules),
    channels: normalizeChannels(req.body.channels),
  });
  await business.save();
  void logAudit({ businessId: req.businessId, userId: req.userId, action: 'role.create', summary: `Creó el rol "${req.body.name}".` });
  res.status(201).json({ success: true, data: { roles: rolesCatalog(business) } });
});

/** PUT /api/members/roles/:id — edita un rol personalizado (aplica a quien lo tenga). */
export const updateCustomRole = asyncHandler(async (req, res) => {
  const business = await Business.findById(req.businessId);
  const role = business.customRoles.id(req.params.id);
  if (!role) throw ApiError.notFound('Ese rol no existe.');
  role.name = req.body.name;
  role.modules = normalizeModules(req.body.modules);
  role.channels = normalizeChannels(req.body.channels);
  business.markModified('customRoles');
  await business.save();
  void logAudit({ businessId: req.businessId, userId: req.userId, action: 'role.update', summary: `Editó el rol "${req.body.name}".` });
  res.json({ success: true, data: { roles: rolesCatalog(business) } });
});

/** DELETE /api/members/roles/:id — borra un rol; quien lo tenía pasa a Solo lectura. */
export const deleteCustomRole = asyncHandler(async (req, res) => {
  const business = await Business.findById(req.businessId);
  const role = business.customRoles.id(req.params.id);
  if (!role) throw ApiError.notFound('Ese rol no existe.');
  const name = role.name;
  role.deleteOne();
  await business.save();
  const moved = await Membership.updateMany(
    { business: req.businessId, roleKey: `role:${req.params.id}` },
    { $set: { roleKey: 'readonly' }, $unset: { access: 1 } }
  );
  void logAudit({ businessId: req.businessId, userId: req.userId, action: 'role.delete', summary: `Borró el rol "${name}".` });
  res.json({ success: true, data: { roles: rolesCatalog(business), moved: moved.modifiedCount } });
});

