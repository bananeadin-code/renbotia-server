import { Subscription } from '../models/Subscription.js';
import { ChatSimulation } from '../models/ChatSimulation.js';
import { UsageLog } from '../models/UsageLog.js';
import { ApiError } from '../utils/ApiError.js';
import { generateReply } from './claude.service.js';
import { applyLazyReset, hasBalance, deductTokens, computeBalance } from './token.service.js';

/**
 * Resumen de una conversación con IA para el agente: qué quiere el cliente + una
 * respuesta sugerida. Es uso REAL de IA, así que descuenta de la billetera del
 * negocio (como un mensaje) y se registra en UsageLog (source 'summary').
 */
const SUMMARY_SYSTEM = `Eres un asistente que resume conversaciones de atención a clientes por WhatsApp para el dueño de un negocio, para que una persona retome la conversación con rapidez.
Devuelve SIEMPRE un JSON válido con EXACTAMENTE estas dos claves, sin texto adicional:
{"resumen": "2 a 4 frases: qué quiere o pidió el cliente y el estado actual", "sugerencia": "una respuesta breve, cordial y lista para enviar que el negocio podría mandar ahora"}
Responde en español, tono profesional y cercano. Básate SOLO en la conversación; no inventes datos.`;

export async function summarizeConversation({ businessId, chatId }) {
  const chat = await ChatSimulation.findOne({ _id: chatId, business: businessId });
  if (!chat) throw ApiError.notFound('Conversación no encontrada');
  if (!chat.messages.length) throw ApiError.badRequest('No hay mensajes que resumir.');

  const subscription = await Subscription.findOne({ business: businessId }).populate('plan');
  if (!subscription) throw ApiError.notFound('No hay suscripción activa');
  await applyLazyReset(subscription);
  if (!hasBalance(subscription, 1)) {
    throw new ApiError(402, 'Sin créditos para generar el resumen.', {
      code: 'LIMIT_REACHED',
      balance: computeBalance(subscription),
    });
  }

  // Transcripción compacta (últimos ~6000 caracteres).
  const transcript = chat.messages
    .map((m) => {
      const who = m.role === 'user' ? 'Cliente' : m.via === 'agent' ? 'Agente' : 'Bot';
      return `${who}: ${m.content}`;
    })
    .join('\n')
    .slice(-6000);

  const result = await generateReply({
    system: SUMMARY_SYSTEM,
    messages: [{ role: 'user', content: `Resume esta conversación y sugiere una respuesta:\n\n${transcript}` }],
  });

  // Descuenta el consumo (uso de IA) y registra el costo real.
  const toDeduct = result.billableTokens ?? result.totalTokens ?? 0;
  const balance = await deductTokens(subscription, toDeduct);
  await UsageLog.create({
    business: businessId,
    date: new Date(),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheReadTokens: result.cacheReadTokens,
    cacheCreationTokens: result.cacheCreationTokens,
    totalTokens: result.totalTokens,
    source: 'summary',
  });

  // Parsea el JSON de forma tolerante.
  let summary = '';
  let suggestion = '';
  try {
    const match = result.text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : result.text);
    summary = String(parsed.resumen || '').trim();
    suggestion = String(parsed.sugerencia || '').trim();
  } catch {
    summary = result.text.trim();
  }

  return { summary, suggestion, balance };
}
