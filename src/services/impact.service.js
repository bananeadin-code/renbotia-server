import { ChatSimulation } from '../models/ChatSimulation.js';
import { ManagedRecord } from '../models/ManagedRecord.js';
import { Subscription } from '../models/Subscription.js';
import '../models/Plan.js'; // registra el modelo para el populate del plan
import { BotConfig } from '../models/BotConfig.js';
import { Business } from '../models/Business.js';
import { isOpenNow } from '../utils/botAvailability.js';

/**
 * "Te rinde cuentas en pesos": lo que el bot hizo en un periodo, en datos reales
 * y en una estimación de dinero con los valores que el dueño define
 * (ticket promedio y costo por hora de quien atendería).
 *
 * Reales: conversaciones atendidas, respuestas del bot, trabajo captado por el
 * bot (citas, reservaciones, pedidos), leads calientes y clientes atendidos
 * fuera de horario. Estimados (siempre etiquetados así en la UI):
 *  - valor del trabajo captado = captado × ticket promedio
 *  - valor del tiempo ahorrado = horas × costo por hora (~2 min por respuesta)
 *  - oportunidades = leads calientes y prospectos × ticket (se muestran aparte,
 *    no se suman: todavía no son ventas).
 */

const REAL_CHANNELS = ['whatsapp', 'facebook', 'instagram', 'web'];
export const DEFAULT_HOURLY_COST = 60; // MXN por hora de atención (editable)

export async function computeImpact(businessId, since, until = new Date()) {
  const range = { $gte: since, $lt: until };
  const [business, sub, botConfig, chats, botAgg, records, hotLeads] = await Promise.all([
    Business.findById(businessId).select('roi').lean(),
    Subscription.findOne({ business: businessId }).populate('plan', 'priceMXN name').lean(),
    BotConfig.findOne({ business: businessId }).select('schedule').lean(),
    // Conversaciones de canales reales con actividad en el periodo (el simulador es prueba).
    ChatSimulation.find({ business: businessId, channel: { $in: REAL_CHANNELS }, updatedAt: range })
      .select('createdAt messages.role messages.timestamp')
      .limit(3000)
      .lean(),
    ChatSimulation.aggregate([
      { $match: { business: businessId, channel: { $in: REAL_CHANNELS } } },
      { $unwind: '$messages' },
      { $match: { 'messages.role': 'assistant', 'messages.via': 'bot', 'messages.timestamp': range } },
      { $count: 'n' },
    ]),
    ManagedRecord.aggregate([
      { $match: { business: businessId, source: 'bot', status: { $ne: 'cancelado' }, createdAt: range } },
      { $group: { _id: '$type', n: { $sum: 1 } } },
    ]),
    ChatSimulation.countDocuments({ business: businessId, hotLeadAt: range }),
  ]);

  const byType = Object.fromEntries(records.map((r) => [r._id, r.n]));
  const captured = (byType.cita || 0) + (byType.reservacion || 0) + (byType.pedido || 0);
  const prospects = byType.prospecto || 0;
  const botReplies = botAgg[0]?.n || 0;
  const hoursSaved = Math.round(((botReplies * 2) / 60) * 10) / 10;

  // Clientes que escribieron con el negocio cerrado (solo si configuró horario):
  // se cuenta la primera vez que escribió cada cliente en el periodo.
  let outsideHours = null;
  if (botConfig?.schedule?.enabled) {
    outsideHours = 0;
    for (const c of chats) {
      const first = (c.messages || []).find((m) => m.role === 'user' && m.timestamp && new Date(m.timestamp) >= since);
      if (first && isOpenNow(botConfig.schedule, new Date(first.timestamp)) === false) outsideHours++;
    }
  }

  const avgTicket = Number(business?.roi?.avgTicket) || 0;
  const hourlyCost = Number(business?.roi?.hourlyCost) || DEFAULT_HOURLY_COST;
  const valueCaptured = Math.round(captured * avgTicket);
  const valueTime = Math.round(hoursSaved * hourlyCost);
  const opportunities = Math.round((hotLeads + prospects) * avgTicket);
  const total = valueCaptured + valueTime;
  const planPrice = sub?.plan?.priceMXN || 0;

  return {
    conversations: chats.length,
    botReplies,
    captured,
    capturedByType: { cita: byType.cita || 0, reservacion: byType.reservacion || 0, pedido: byType.pedido || 0 },
    prospects,
    hotLeads,
    outsideHours,
    hoursSaved,
    settings: { avgTicket, hourlyCost, configured: avgTicket > 0 },
    value: { captured: valueCaptured, time: valueTime, total, opportunities },
    planPrice,
    planName: sub?.plan?.name || '',
    // Cuántas veces el valor estimado cubre el costo del plan (si es de pago).
    roiMultiple: planPrice > 0 && total > 0 ? Math.round((total / planPrice) * 10) / 10 : null,
  };
}
