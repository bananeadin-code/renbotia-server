import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';
import { WALLET_TOKEN_WEIGHTS } from '../config/constants.js';

// Un solo caché para configuración + entrenamiento. TTL de 1 hora para que el
// bloque persista casi toda la sesión del cliente (se reconstruye solo cuando
// edita su bot), maximizando las lecturas de caché (baratas) frente a reescrituras.
const SYSTEM_CACHE_CONTROL = { type: 'ephemeral', ttl: '1h' };

/**
 * Tokens que se DESCUENTAN al cliente (billetera), aprovechando el caché:
 * el config/entrenamiento reutilizado (cacheRead) casi no cuenta. No cambia el
 * costo real que se registra en UsageLog; solo abarata el consumo del cliente.
 */
function computeBillable({ inputTokens = 0, cacheCreationTokens = 0, cacheReadTokens = 0, outputTokens = 0 }) {
  const w = WALLET_TOKEN_WEIGHTS;
  return Math.round(
    inputTokens * w.input +
      cacheCreationTokens * w.cacheCreation +
      cacheReadTokens * w.cacheRead +
      outputTokens * w.output
  );
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
export async function generateReply({ system, messages }) {
  const anthropic = getClient();

  try {
    const response = await anthropic.messages.create({
      model: env.anthropic.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      // Un solo caché de config+entrenamiento (system prompt), estable entre
      // mensajes. TTL 1h: persiste casi toda la sesión y se reconstruye solo al
      // editar el bot. Si el prompt es corto (<1024 tokens) la API no cachea, sin error.
      system: [{ type: 'text', text: system, cache_control: SYSTEM_CACHE_CONTROL }],
      messages,
    });

    // El contenido puede venir en varios bloques; concatenamos los de texto.
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

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
      billableTokens: computeBillable({ inputTokens, cacheCreationTokens, cacheReadTokens, outputTokens }),
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
export async function generateReplyWithTools({ system, messages, tools, executeTool }) {
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

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await anthropic.messages.create({
        model: env.anthropic.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: [{ type: 'text', text: system, cache_control: SYSTEM_CACHE_CONTROL }],
        tools,
        messages: convo,
      });

      const u = usageFrom(response);
      for (const k of Object.keys(totals)) totals[k] += u[k];

      if (response.stop_reason === 'tool_use') {
        // Guardamos el turno del asistente (incluye los bloques tool_use).
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
      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();

      return { text: text || '(sin respuesta)', ...totals, billableTokens: computeBillable(totals), toolCalls };
    }

    // Si se agotan las rondas, devolvemos un cierre razonable.
    return {
      text: 'Disculpa, tuve un problema procesando eso. ¿Puedes intentarlo de nuevo?',
      ...totals,
      billableTokens: computeBillable(totals),
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
