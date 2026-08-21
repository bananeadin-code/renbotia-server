import crypto from 'crypto';
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

  const members = memberships
    .filter((m) => m.user)
    .map((m) => ({
      userId: m.user._id,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      isMe: String(m.user._id) === String(req.userId),
    }));

  res.json({
    success: true,
    data: {
      myRole: req.membershipRole,
      members,
      invitations: invitations.map((i) => ({ id: i._id, email: i.email, role: i.role, expiresAt: i.expiresAt })),
    },
  });
});

export const inviteSchema = z.object({ email: z.string().email('Correo inválido') });

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
    { $setOnInsert: { role: invitation.role } },
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
