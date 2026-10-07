import { Business } from '../models/Business.js';
import { ChatSimulation } from '../models/ChatSimulation.js';
import { LearningSuggestion } from '../models/LearningSuggestion.js';
import { computeImpact } from './impact.service.js';
import { sendWeeklyReportEmail } from './email.service.js';
import { logger } from '../utils/logger.js';

/**
 * Reporte semanal del lunes al dueño (correo): resultados de la semana en datos
 * y en pesos, leads calientes para llamar y lo pendiente por enseñar al bot.
 * Se manda los lunes desde las 8:00 (hora de México), una vez por semana y solo
 * si hubo actividad o algo por enseñar. El dueño lo puede apagar.
 */

const DAY = 24 * 60 * 60 * 1000;
let running = false;

/** ¿Es lunes a partir de las 8:00 en la Ciudad de México? */
function isMondayMorningMx(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Mexico_City',
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const wd = parts.find((x) => x.type === 'weekday')?.value;
  const h = Number(parts.find((x) => x.type === 'hour')?.value);
  return wd === 'Mon' && h >= 8;
}

export async function buildWeeklyReport(businessId, now = new Date()) {
  const since = new Date(now.getTime() - 7 * DAY);
  const [impact, leads, learning, learningTotal] = await Promise.all([
    computeImpact(businessId, since, now),
    ChatSimulation.find({ business: businessId, hotLead: true })
      .sort({ hotLeadAt: -1 })
      .limit(3)
      .select('customerName title hotLeadReason')
      .lean(),
    LearningSuggestion.find({ business: businessId, status: 'pending' }).sort({ updatedAt: -1 }).limit(3).select('question').lean(),
    LearningSuggestion.countDocuments({ business: businessId, status: 'pending' }),
  ]);
  return {
    impact,
    leads: leads.map((l) => ({ name: l.customerName || l.title || 'Cliente', reason: l.hotLeadReason || '' })),
    learning: learning.map((s) => ({ question: s.question })),
    learningTotal,
  };
}

export async function runWeeklyReports({ force = false } = {}) {
  if (running) return { skipped: true };
  if (!force && !isMondayMorningMx()) return { skipped: true };
  running = true;
  let sent = 0;
  try {
    const cutoff = new Date(Date.now() - 6 * DAY); // una vez por semana
    const businesses = await Business.find({
      weeklyReport: { $ne: false },
      $or: [{ weeklyReportAt: null }, { weeklyReportAt: { $lt: cutoff } }],
    })
      .select('_id name owner')
      .lean();
    for (const b of businesses) {
      // Reclamo atómico (varias instancias / reinicios no duplican el correo).
      const claim = await Business.updateOne(
        { _id: b._id, $or: [{ weeklyReportAt: null }, { weeklyReportAt: { $lt: cutoff } }] },
        { $set: { weeklyReportAt: new Date() } },
        { timestamps: false }
      );
      if (!claim.modifiedCount) continue;
      try {
        const report = await buildWeeklyReport(b._id);
        // Sin actividad ni pendientes: no se manda un correo vacío.
        if (!report.impact.conversations && !report.learningTotal) continue;
        await sendWeeklyReportEmail({ userId: b.owner, businessName: b.name, ...report });
        sent++;
      } catch (err) {
        logger.warn(`Reporte semanal: negocio ${b._id}: ${err.message}`);
      }
    }
    if (sent) logger.info(`Reporte semanal: ${sent} correo(s) enviados.`);
    return { sent };
  } finally {
    running = false;
  }
}

export function startWeeklyReportScheduler() {
  const run = () => runWeeklyReports().catch((err) => logger.warn(`Reporte semanal: ${err.message}`));
  setTimeout(run, 3 * 60 * 1000).unref?.();
  setInterval(run, 60 * 60 * 1000).unref?.();
}
