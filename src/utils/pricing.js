import { PRICING, USD_TO_MXN } from '../config/constants.js';

/**
 * Estima el costo real en USD de un consumo de tokens, diferenciando input,
 * output y caché (lectura/escritura). Ver PRICING en config/constants.js.
 */
export function estimateCostUSD({
  inputTokens = 0,
  outputTokens = 0,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
} = {}) {
  return (
    (inputTokens * PRICING.inputPerM +
      cacheCreationTokens * PRICING.cacheWritePerM +
      cacheReadTokens * PRICING.cacheReadPerM +
      outputTokens * PRICING.outputPerM) /
    1_000_000
  );
}

export const usdToMxn = (usd) => usd * USD_TO_MXN;
