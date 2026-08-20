import { Subscription } from '../models/Subscription.js';
import { BotConfig } from '../models/BotConfig.js';
import { ChatSimulation } from '../models/ChatSimulation.js';
import { UsageLog } from '../models/UsageLog.js';
import { ApiError } from '../utils/ApiError.js';
import { ManagementConfig } from '../models/ManagementConfig.js';
import { buildSystemPrompt } from './promptBuilder.service.js';
import { generateReply, generateReplyWithTools } from './claude.service.js';
import { applyLazyReset, hasBalance, deductTokens, computeBalance } from './token.service.js';
import { buildTools, executeTool as runManagementTool } from './managementTools.service.js';
import { usableImages, buildImageTool, executeImageTool } from './imageTools.service.js';
import { buildEscalationTool } from './handoffTools.service.js';
import { maybeAutoRecharge } from './autoRecharge.service.js';
import { maybeNotifyLowBalance } from './lowBalance.service.js';
import { sanitizeBotConfigForPlan } from '../utils/planGating.js';
import { logger } from '../utils/logger.js';

// Cuántos mensajes previos enviar como contexto a Claude (ventana deslizante).
const HISTORY_WINDOW = 20;

/**
 * Procesa un mensaje del simulador para un negocio dado.
 *
 * @param {object} params
 * @param {import('mongoose').Types.ObjectId} params.businessId
 * @param {object} params.business - documento Business (para el prompt)
 * @param {string} params.message - texto del usuario
 * @param {string} [params.chatId] - conversación a continuar; si no, se crea una
 * @returns {Promise<{ reply, chatId, balance, usage }>}
 */
export async function processMessage({ businessId, business, message, chatId }) {
  // 1) Suscripción + reseteo perezoso + verificación de créditos
  const subscription = await Subscription.findOne({ business: businessId }).populate('plan');
  if (!subscription) {
    throw ApiError.notFound('No hay suscripción activa para este negocio');
  }
  await applyLazyReset(subscription);

  if (!hasBalance(subscription, 1)) {
    // Sin créditos: intenta recarga automática (si el cliente la programó) para
    // no quedarse varado, como el auto-reload de la consola de Claude.
    await maybeAutoRecharge({ subscription, businessId, userId: business?.owner });
    if (!hasBalance(subscription, 1)) {
      // Sigue sin créditos: 402. El frontend muestra el CTA a comprar.
      throw new ApiError(402, 'Se alcanzó el límite de tokens de tu plan', {
        code: 'LIMIT_REACHED',
        balance: computeBalance(subscription),
      });
    }
  }

  // 2) Configuración del bot
  const botConfig = await BotConfig.findOne({ business: businessId });
  if (!botConfig) {
    throw ApiError.notFound('El bot no está configurado');
  }

  // Barrera de plan en RUNTIME (defensa en profundidad): aunque lo guardado
  // tenga tono/personalidad/contexto/FAQs/imágenes fuera del plan (datos viejos,
  // del seed o de una degradación de plan), aquí se recorta para que la ejecución
  // respete SIEMPRE los límites vigentes (p. ej. Free = tono neutral, sin
  // personalidad ni contexto ampliado). No basta con sanear solo al guardar.
  const planKey = subscription.plan?.key || 'free';
  const safeConfig = sanitizeBotConfigForPlan(botConfig.toObject(), planKey);

  // 3) Cargar o crear la conversación (aislada por tenant)
  let chat;
  if (chatId) {
    chat = await ChatSimulation.findOne({ _id: chatId, business: businessId });
    if (!chat) throw ApiError.notFound('Conversación no encontrada');
  } else {
    chat = new ChatSimulation({
      business: businessId,
      title: message.slice(0, 40) || 'Nueva conversación',
      messages: [],
    });
  }

  // Relevo humano: si una persona tomó el control (modo manual), el bot NO
  // responde. Se guarda el mensaje del cliente y se avisa que está en pausa; la
  // respuesta la dará la persona desde la bandeja de Conversaciones. No consume
  // tokens ni llama a la IA.
  if (chat.handoffMode === 'manual') {
    chat.messages.push({ role: 'user', content: message, timestamp: new Date() });
    await chat.save();
    return {
      reply: null,
      paused: true,
      chatId: chat._id,
      balance: computeBalance(subscription),
      usage: { charged: 0 },
      createdRecords: [],
      sentImages: [],
    };
  }

  // 4) Módulo de Gestión: solo Elite y con el módulo activado. Si aplica, el bot
  //    puede consultar disponibilidad y agendar/registrar trabajo con herramientas.
  const isElite = planKey === 'elite';
  let managementConfig = null;
  if (isElite) {
    const mc = await ManagementConfig.findOne({ business: businessId });
    if (mc?.enabled && (mc.enabledTypes || []).length) managementConfig = mc;
  }
  // Imágenes que el bot puede ENVIAR (Elite, con nombre + fuente). Usa el config
  // ya saneado por plan (para no-Elite queda en []).
  const imagesForBot = isElite ? usableImages(safeConfig) : [];

  // 5) Construir el contexto para Claude (ventana de historial + mensaje nuevo)
  const system = buildSystemPrompt(safeConfig, business, managementConfig);
  const history = chat.messages.slice(-HISTORY_WINDOW).map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const claudeMessages = [...history, { role: 'user', content: message }];

  // 6) Herramientas disponibles: gestión (citas/pedidos…), imágenes del bot y
  //    la escalación a humano (esta última para TODOS los planes).
  const tools = [buildEscalationTool()];
  if (managementConfig) tools.push(...buildTools(managementConfig));
  if (imagesForBot.length) tools.push(buildImageTool(imagesForBot));

  let text, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, totalTokens, billableTokens;
  const createdRecords = [];
  const sentImages = []; // imágenes que el bot envió en este turno (para renderizarlas)
  const escalation = { flagged: false, reason: '' }; // el bot pidió atención humana

  try {
    if (tools.length) {
      // Un despachador único enruta cada llamada de herramienta. Devuelve al modelo
      // solo el resultado conciso; los efectos (registros, imágenes) se capturan aparte.
      const executeTool = async (name, input) => {
        if (name === 'escalar_a_humano') {
          escalation.flagged = true;
          escalation.reason = input?.motivo || '';
          return {
            ok: true,
            mensaje:
              'Conversación marcada para que la atienda una persona. Dile al cliente con cortesía ' +
              'que en un momento lo atenderá alguien del equipo.',
          };
        }
        if (name === 'enviar_imagen') {
          const { result, image } = executeImageTool(input, imagesForBot);
          if (image) sentImages.push(image);
          return result;
        }
        const { result, record } = await runManagementTool({
          name,
          input,
          businessId,
          config: managementConfig,
          chatId: chat._id,
        });
        if (record) {
          createdRecords.push({
            id: record.id,
            type: record.type,
            summary: record.summary,
            scheduledAt: record.scheduledAt,
          });
        }
        return result;
      };
      ({ text, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, totalTokens, billableTokens } =
        await generateReplyWithTools({ system, messages: claudeMessages, tools, executeTool }));
    } else {
      ({ text, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, totalTokens, billableTokens } =
        await generateReply({ system, messages: claudeMessages }));
    }
  } catch (err) {
    // Un 503 es un problema de CONFIGURACIÓN (p. ej. API key inválida): debe verlo
    // el dueño, así que se relanza. Cualquier otro fallo de la IA (saturación,
    // timeout, caída de Anthropic) se DEGRADA con gracia: el cliente recibe un
    // aviso amable, NO se descuentan tokens y la conversación no se rompe.
    if (err.statusCode === 503) throw err;
    logger.warn(`Simulador: IA no disponible (${err.statusCode || 'sin status'}); se degrada. ${err.message}`);
    return {
      reply: 'En este momento no puedo responder. Por favor intenta de nuevo en unos minutos.',
      chatId: chatId || null, // no persistimos; el cliente puede reintentar
      degraded: true,
      balance: computeBalance(subscription),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, charged: 0 },
      createdRecords: [],
      sentImages: [],
    };
  }

  // 7) Descontar a la billetera los tokens FACTURABLES (con el caché abaratado);
  //    el consumo real (totalTokens) se guarda en UsageLog para el costo.
  const toDeduct = billableTokens ?? totalTokens;
  let balance = await deductTokens(subscription, toDeduct);

  // Recarga automática proactiva: si el saldo cayó al umbral programado, compra
  // el pack antes de quedarse en 0 (para no cortar el servicio en el próximo mensaje).
  const auto = await maybeAutoRecharge({ subscription, businessId, userId: business?.owner });
  if (auto.recharged && auto.balance) balance = auto.balance;

  // Si no se recargó automáticamente y el saldo quedó bajo, avisa por email una
  // vez (para no apagar el bot sin previo aviso). Guarda internamente contra spam.
  if (!auto.recharged) {
    void maybeNotifyLowBalance({ subscription, businessId, userId: business?.owner });
  }

  // 8) Persistir mensajes en la conversación
  const now = new Date();
  const promptTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
  chat.messages.push({ role: 'user', content: message, tokens: promptTokens, timestamp: now });
  chat.messages.push({
    role: 'assistant',
    content: text,
    tokens: outputTokens,
    via: 'bot',
    images: sentImages.length ? sentImages : undefined,
    timestamp: now,
  });
  // Si el bot escaló, la conversación pasa a requerir atención humana.
  if (escalation.flagged) {
    chat.needsAttention = true;
    chat.attentionReason = escalation.reason;
  }
  await chat.save();

  // 9) Registrar el consumo (append-only) para la gráfica y el costo real en admin
  await UsageLog.create({
    business: businessId,
    date: now,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    source: 'simulator',
  });

  return {
    reply: text,
    chatId: chat.id,
    balance,
    // charged = créditos descontados al cliente (con caché abaratado);
    // totalTokens = consumo lógico completo (referencia).
    usage: { inputTokens, outputTokens, totalTokens, charged: toDeduct },
    createdRecords,
    sentImages, // imágenes reales que el bot adjuntó (para renderizarlas en el chat)
    escalated: escalation.flagged, // el bot pidió que atienda una persona
  };
}
