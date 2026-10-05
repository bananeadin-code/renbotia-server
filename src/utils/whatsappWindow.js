/**
 * Ventana de servicio de 24 h de Meta (WhatsApp, Messenger e Instagram).
 *
 * Desde el ÚLTIMO mensaje ENTRANTE del cliente (role 'user'), el negocio puede
 * enviarle mensajes de TEXTO LIBRE durante 24 horas. Fuera de esa ventana:
 * - WhatsApp solo permite mensajes con PLANTILLA aprobada.
 * - Messenger e Instagram no permiten responder (hay que esperar a que el cliente escriba).
 * Este helper la calcula para mostrar el estado en la bandeja y decidir qué se
 * puede enviar.
 */
const WINDOW_MS = 24 * 60 * 60 * 1000;
const WINDOW_CHANNELS = ['whatsapp', 'facebook', 'instagram'];

/**
 * @param {{ channel?: string, messages?: Array<{role:string,timestamp?:Date}> }} chat
 * @returns {{ open: boolean, lastInboundAt: Date|null, expiresAt: Date|null } | null}
 *   Devuelve null si el canal no tiene ventana (simulador).
 */
export function computeServiceWindow(chat) {
  if (!chat || !WINDOW_CHANNELS.includes(chat.channel)) return null;

  let lastInboundAt = null;
  const msgs = chat.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') {
      lastInboundAt = msgs[i].timestamp || null;
      break;
    }
  }

  // Sin ningún mensaje del cliente todavía: la ventana no está abierta.
  if (!lastInboundAt) return { open: false, lastInboundAt: null, expiresAt: null };

  const expiresAt = new Date(new Date(lastInboundAt).getTime() + WINDOW_MS);
  return { open: Date.now() < expiresAt.getTime(), lastInboundAt, expiresAt };
}
