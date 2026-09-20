import { PRICING, PRICING_BY_MODEL, USD_TO_MXN } from '../config/constants.js';

/**
 * Estima el costo real en USD de un consumo de tokens, diferenciando input,
 * output y caché (lectura/escritura). Si se pasa `model`, usa sus precios reales
 * (PRICING_BY_MODEL); si no, cae al PRICING por defecto (conservador). Así el
 * costo cuadra aunque cada plan corra en un modelo distinto (Haiku/Sonnet).
 */
export function estimateCostUSD(
  { inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0 } = {},
  model = null
) {
  const p = (model && PRICING_BY_MODEL[model]) || PRICING;
  return (
    (inputTokens * p.inputPerM +
      cacheCreationTokens * p.cacheWritePerM +
      cacheReadTokens * p.cacheReadPerM +
      outputTokens * p.outputPerM) /
    1_000_000
  );
}

export const usdToMxn = (usd) => usd * USD_TO_MXN;
