import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';
import { WALLET_TOKEN_WEIGHTS, WALLET_DISCOUNT, MODEL_SETTINGS } from '../config/constants.js';

// Un solo caché para configuración + entrenamiento. TTL de 1 hora para que el
// bloque persista casi toda la sesión del cliente (se reconstruye solo cuando
// edita su bot), maximizando las lecturas de caché (baratas) frente a reescrituras.
const SYSTEM_CACHE_CONTROL = { type: 'ephemeral', ttl: '1h' };
// Caché del HISTORIAL (TTL de 5 min): en una conversación activa, los mensajes
// anteriores se vuelven a leer al 10% en vez de cobrarse completos, y en el loop
// de herramientas cada ronda reutiliza la anterior. Va después del de 1 h (la API
// exige que el TTL más largo vaya primero).
const HISTORY_CACHE_CONTROL = { type: 'ephemeral' };
const CACHEABLE_BLOCKS = new Set(['text', 'image', 'document', 'tool_result']);

// Respuesta cuando el modelo declina o no alcanza a escribir texto.
const REFUSAL_TEXT = 'Disculpa, no puedo ayudarte con eso por este medio. Si quieres, te comunico con una persona del equipo.';

/**
 * Tokens que se DESCUENTAN al cliente (billetera), aprovechando el caché:
 * el config/entrenamiento reutilizado (cacheRead) casi no cuenta. No cambia el
 * costo real que se registra en UsageLog; solo abarata el consumo del cliente.
 * `model` aplica el factor del tokenizador (ver MODEL_SETTINGS.walletFactor).
 */
function computeBillable({ inputTokens = 0, cacheCreationTokens = 0, cacheReadTokens = 0, outputTokens = 0 }, model) {
  const w = WALLET_TOKEN_WEIGHTS;
  const weighted =
    inputTokens * w.input +
    cacheCreationTokens * w.cacheCreation +
    cacheReadTokens * w.cacheRead +
    outputTokens * w.output;
  const factor = MODEL_SETTINGS[model]?.walletFactor ?? 1;
  // Descuento global adicional (el cliente consume ~15% menos).
  return Math.round(weighted * WALLET_DISCOUNT * factor);
}

/** Parámetros propios del modelo: effort y espacio para el pensamiento. */
function modelParams(model, maxTokens, { withTools = false } = {}) {
  const s = MODEL_SETTINGS[model];
  if (!s) return { max_tokens: maxTokens };
  return {
    max_tokens: maxTokens + s.outputHeadroom,
    output_config: { effort: withTools ? s.toolEffort : s.effort },
  };
}

/**
 * Copia de `messages` con un punto de caché al final (no modifica el original,
 * que es el historial guardado). Solo en bloques que aceptan cache_control.
 */
function withHistoryCache(messages) {
  if (!messages.length) return messages;
  const out = messages.slice(0, -1);
  const last = messages[messages.length - 1];
  if (typeof last.content === 'string') {
    if (!last.content) return messages;
    out.push({ ...last, content: [{ type: 'text', text: last.content, cache_control: HISTORY_CACHE_CONTROL }] });
    return out;
  }
  if (!Array.isArray(last.content) || !last.content.length) return messages;
  const blocks = [...last.content];
  const tail = blocks[blocks.length - 1];
  if (!CACHEABLE_BLOCKS.has(tail?.type)) return messages;
  blocks[blocks.length - 1] = { ...tail, cache_control: HISTORY_CACHE_CONTROL };
  out.push({ ...last, content: blocks });
  return out;
}

/** Texto final de una respuesta (lee por tipo: puede empezar con bloques de pensamiento). */
function replyText(response) {
  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
  if (text) return text;
  // Declinó por seguridad, o el pensamiento agotó el tope antes de escribir.
  if (response.stop_reason === 'refusal') {
    logger.warn(`Claude declinó (${response.stop_details?.category || 'sin categoría'}).`);
    return REFUSAL_TEXT;
  }
  if (response.stop_reason === 'max_tokens') logger.warn('Claude agotó max_tokens sin texto.');
  return '';
}

/**
 * Cliente Anthropic (Claude). La API key vive SOLO aquí, en el backend, vía
 * variable de entorno; nunca se expone al cliente.
 *
 * Se inicializa de forma perezosa para que importar este módulo no falle si la
 * key aún no está configurada (útil en tests y en el arranque).
 */
let client = null;

function getClient() {
  if (!env.anthropic.apiKey) {
    throw new ApiError(503, 'El servicio de IA no está configurado (falta ANTHROPIC_API_KEY)');
  }
  if (!client) {
    // timeout: corta esperas colgadas (para degradar con gracia en vez de dejar
    // al cliente esperando). maxRetries bajo: fallar rápido y avisar.
    client = new Anthropic({ apiKey: env.anthropic.apiKey, timeout: 30000, maxRetries: 1 });
  }
  return client;
}

const MAX_OUTPUT_TOKENS = 500; // respuestas cortas estilo WhatsApp

/**
 * Genera una respuesta del bot.
 *
 * @param {object} params
 * @param {string} params.system - system prompt ya armado
 * @param {Array<{role:'user'|'assistant', content:string}>} params.messages - historial
 * @returns {Promise<{ text: string, inputTokens: number, outputTokens: number, totalTokens: number }>}
 */
export async function generateReply({ system, messages, model, maxTokens }) {
  const anthropic = getClient();

  const usedModel = model || env.anthropic.model;
  try {
    const response = await anthropic.messages.create({
      model: usedModel,
      // maxTokens: tareas internas que devuelven más texto (p. ej. extraer un perfil en JSON).
      ...modelParams(usedModel, maxTokens || MAX_OUTPUT_TOKENS),
      // Un solo caché de config+entrenamiento (system prompt), estable entre
      // mensajes. TTL 1h: persiste casi toda la sesión y se reconstruye solo al
      // editar el bot. Si el prompt es corto la API no cachea, sin error.
      system: [{ type: 'text', text: system, cache_control: SYSTEM_CACHE_CONTROL }],
      // Conversaciones de varias vueltas: también se cachea el historial. En una
      // sola petición (importar, extraer) no hay nada que reutilizar después.
      messages: messages.length > 1 ? withHistoryCache(messages) : messages,
    });

    const text = replyText(response);

    const u = response.usage || {};
    const inputTokens = u.input_tokens ?? 0; // prompt no cacheado
    const outputTokens = u.output_tokens ?? 0;
    const cacheReadTokens = u.cache_read_input_tokens ?? 0; // servido desde caché (~0.1x)
    const cacheCreationTokens = u.cache_creation_input_tokens ?? 0; // escrito a caché

    if (cacheReadTokens > 0) {
      logger.debug(`Claude cache hit: ${cacheReadTokens} tokens leídos de caché`);
    }

    return {
      text: text || '(sin respuesta)',
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      // totalTokens = consumo REAL (para UsageLog/costo): todo el prompt + salida.
      totalTokens: inputTokens + cacheReadTokens + cacheCreationTokens + outputTokens,
      // billableTokens = lo que se DESCUENTA al cliente, con el caché abaratado.
      billableTokens: computeBillable({ inputTokens, cacheCreationTokens, cacheReadTokens, outputTokens }, usedModel),
    };
  } catch (err) {
    logger.error(`Anthropic API error: ${err.status || ''} ${err.message}`);

    // Traducimos errores comunes a mensajes claros para el cliente.
    if (err.status === 401) {
      throw new ApiError(503, 'La API key de IA es inválida. Revisa la configuración del servidor.');
    }
    if (err.status === 429) {
      throw new ApiError(429, 'El servicio de IA está saturado, intenta de nuevo en unos segundos.');
    }
    throw new ApiError(502, 'No se pudo obtener respuesta del servicio de IA.');
  }
}

function usageFrom(response) {
  const u = response.usage || {};
  const inputTokens = u.input_tokens ?? 0;
  const outputTokens = u.output_tokens ?? 0;
  const cacheReadTokens = u.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = u.cache_creation_input_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: inputTokens + cacheReadTokens + cacheCreationTokens + outputTokens,
  };
}

const MAX_TOOL_ROUNDS = 5; // tope de seguridad para el loop agéntico

/**
 * Igual que generateReply pero con herramientas (tool use). Ejecuta un loop
 * agéntico: si Claude pide una herramienta, la ejecuta con `executeTool`, le
 * devuelve el resultado y continúa hasta que produce texto final. Acumula el
 * consumo de TODAS las llamadas a la API (el cliente paga todo el trabajo).
 *
 * @param {object} params
 * @param {string} params.system
 * @param {Array} params.messages - historial + mensaje nuevo
 * @param {Array} params.tools - definiciones de herramientas (Anthropic)
 * @param {(name:string, input:object)=>Promise<object>} params.executeTool
 * @returns {Promise<{ text, ...usage, toolCalls }>}
 */
export async function generateReplyWithTools({ system, messages, tools, executeTool, model }) {
  const anthropic = getClient();

  const convo = [...messages];
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
  };
  const toolCalls = [];
  const usedModel = model || env.anthropic.model;

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await anthropic.messages.create({
        model: usedModel,
        ...modelParams(usedModel, MAX_OUTPUT_TOKENS, { withTools: true }),
        system: [{ type: 'text', text: system, cache_control: SYSTEM_CACHE_CONTROL }],
        tools,
        // Cada ronda reutiliza del caché lo enviado en la anterior.
        messages: withHistoryCache(convo),
      });

      const u = usageFrom(response);
      for (const k of Object.keys(totals)) totals[k] += u[k];

      if (response.stop_reason === 'tool_use') {
        // Guardamos el turno del asistente TAL CUAL (tool_use y, en modelos 5.5,
        // bloques de pensamiento: deben regresar sin cambios).
        convo.push({ role: 'assistant', content: response.content });

        // Ejecutamos cada herramienta pedida y armamos los tool_result.
        const toolResults = [];
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;
          const result = await executeTool(block.name, block.input);
          toolCalls.push({ name: block.name, input: block.input, result });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        }
        convo.push({ role: 'user', content: toolResults });
        continue; // otra ronda para que Claude responda con el resultado
      }

      // Respuesta final (texto).
      const text = replyText(response);

      return { text: text || '(sin respuesta)', ...totals, billableTokens: computeBillable(totals, usedModel), toolCalls };
    }

    // Si se agotan las rondas, devolvemos un cierre razonable.
    return {
      text: 'Disculpa, tuve un problema procesando eso. ¿Puedes intentarlo de nuevo?',
      ...totals,
      billableTokens: computeBillable(totals, usedModel),
      toolCalls,
    };
  } catch (err) {
    logger.error(`Anthropic API error (tools): ${err.status || ''} ${err.message}`);
    if (err.status === 401) {
      throw new ApiError(503, 'La API key de IA es inválida. Revisa la configuración del servidor.');
    }
    if (err.status === 429) {
      throw new ApiError(429, 'El servicio de IA está saturado, intenta de nuevo en unos segundos.');
    }
    throw new ApiError(502, 'No se pudo obtener respuesta del servicio de IA.');
  }
}
