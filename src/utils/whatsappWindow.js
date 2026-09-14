/**
 * Ventana de servicio de 24 h de WhatsApp.
 *
 * Desde el ÚLTIMO mensaje ENTRANTE del cliente (role 'user'), el negocio puede
 * enviarle mensajes de TEXTO LIBRE durante 24 horas. Fuera de esa ventana, Meta
 * SOLO permite mensajes con PLANTILLA aprobada. Este helper la calcula para
 * mostrar el estado en la bandeja y decidir qué se puede enviar.
 */
const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * @param {{ channel?: string, messages?: Array<{role:string,timestamp?:Date}> }} chat
 * @returns {{ open: boolean, lastInboundAt: Date|null, expiresAt: Date|null } | null}
 *   Devuelve null si la conversación NO es de WhatsApp (la ventana no aplica).
 */
export function computeServiceWindow(chat) {
  if (!chat || chat.channel !== 'whatsapp') return null;

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
