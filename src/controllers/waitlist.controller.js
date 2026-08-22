import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { Waitlist } from '../models/Waitlist.js';
import { isDisposableEmail } from '../utils/disposableEmails.js';

export const joinSchema = z.object({
  email: z.string().email('Email inválido'),
  planKey: z.enum(['pro', 'elite']),
});

/** POST /api/waitlist — apuntar un correo a la lista de espera de un plan (público). */
export const joinWaitlist = asyncHandler(async (req, res) => {
  const email = req.body.email.trim().toLowerCase();
  if (isDisposableEmail(email)) {
    return res.json({ success: true, message: '¡Listo! Te avisamos cuando esté disponible.' });
  }
  await Waitlist.updateOne(
    { email, planKey: req.body.planKey },
    { $setOnInsert: { email, planKey: req.body.planKey } },
    { upsert: true }
  );
  res.json({ success: true, message: '¡Listo! Te avisamos cuando esté disponible.' });
});

/** GET /api/admin/waitlist — lista los interesados (solo admin). */
export const listWaitlist = asyncHandler(async (req, res) => {
  const entries = await Waitlist.find().sort({ createdAt: -1 }).limit(1000).lean();
  const byPlan = entries.reduce((acc, e) => {
    acc[e.planKey] = (acc[e.planKey] || 0) + 1;
    return acc;
  }, {});
  res.json({ success: true, data: { entries, total: entries.length, byPlan } });
});
