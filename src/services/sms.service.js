import { logger } from '../utils/logger.js';

/**
 * Envío de SMS. Por ahora está MOCKEADO (igual que Stripe en modo test al
 * inicio): registra el mensaje y no envía nada real. El código OTP se devuelve
 * al cliente en desarrollo (ver business.controller) para probar el flujo sin
 * un proveedor de SMS.
 *
 * PARA PRODUCCIÓN (cuando conectemos WhatsApp real): integrar aquí un proveedor
 * — p. ej. Twilio (`twilio` npm) — leyendo credenciales desde env:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM.
 * O bien enviar el código por una plantilla de WhatsApp una vez tengamos la
 * Cloud API. La firma se mantiene igual para no tocar el controlador.
 *
 * @param {{ to: string, body: string }} msg
 * @returns {Promise<{ ok: boolean, mock?: boolean }>}
 */
export async function sendSms({ to, body }) {
  // TODO(WhatsApp real): reemplazar por el proveedor real.
  logger.info(`[sms:mock] Para ${to}: ${body}`);
  return { ok: true, mock: true };
}
