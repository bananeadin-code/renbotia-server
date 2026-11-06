import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendContactEmail } from '../services/email.service.js';
import { Business } from '../models/Business.js';
import { Subscription } from '../models/Subscription.js';
import { Lead } from '../models/Lead.js';
import { User } from '../models/User.js';
import { ROLES } from '../config/constants.js';
import { logger } from '../utils/logger.js';

export const SUPPORT_TOPICS = ['Conexión de WhatsApp', 'Entrenamiento del bot', 'Otra sesión de orientación', 'Facturación', 'Ventas y planes', 'Otro'];

export const supportMessageSchema = z.object({
  topic: z.enum(SUPPORT_TOPICS).optional(),
  message: z.string().trim().min(10, 'Cuéntanos un poco más').max(2000),
});

/**
 * POST /api/support/message — mensaje al equipo desde la sección Ayuda del panel.
 * A diferencia del formulario público, ya sabemos quién escribe: el correo llega
 * con su negocio y plan, y queda como nota en su ficha del Embudo para el equipo.
 */
export const sendSupportMessage = asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId).select('name email role').lean();
  const business = req.businessId
    ? await Business.findById(req.businessId).select('name owner').lean()
    : await Business.findOne({ owner: req.userId }).select('name owner').lean();
  const sub = business ? await Subscription.findOne({ business: business._id }).populate('plan', 'name').lean() : null;
  const topic = req.body.topic || 'Otro';
  const account = [
    business ? `Negocio: ${business.name}` : 'Sin negocio',
    sub?.plan?.name ? `Plan ${sub.plan.name}${sub.billingCycle === 'anual' ? ' anual' : ''}${sub.status === 'cancelada' ? ' (cancelado)' : ''}` : '',
    `Usuario: ${user?.email || req.userId}`,
  ]
    .filter(Boolean)
    .join(' · ');

  const result = await sendContactEmail({
    name: user?.name || 'Cliente',
    email: user?.email || '',
    topic: `${topic} (desde el panel)`,
    message: `${req.body.message}\n\n— ${account}`,
  });
  if (result?.skipped) logger.warn(`[support] Mensaje no entregado (buzón sin configurar) de ${user?.email}`);

  // Nota en la ficha del dueño del negocio para que el equipo lo atienda hoy.
  try {
    const ownerId = business?.owner || req.userId;
    const owner = await User.findById(ownerId).select('role').lean();
    if (owner?.role === ROLES.CLIENTE) {
      await Lead.updateOne(
        { user: ownerId },
        {
          $setOnInsert: { user: ownerId, stage: 'nuevo' },
          $set: { nextFollowUpAt: new Date() },
          $push: {
            notes: {
              $each: [{ by: req.userId, byName: user?.name || 'Cliente', text: `Mensaje desde Ayuda (${topic}): ${req.body.message}`.slice(0, 1000) }],
              $slice: -200,
            },
          },
        },
        { upsert: true }
      );
    }
  } catch (err) {
    logger.warn(`[support] Nota en CRM: ${err.message}`);
  }

  res.json({ success: true, message: `Recibimos tu mensaje. Te respondemos a ${user?.email || 'tu correo'} lo antes posible.` });
});
