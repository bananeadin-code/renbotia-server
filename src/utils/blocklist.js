/**
 * Contactos bloqueados por el negocio y tope diario de mensajes por cliente.
 */

// Mensajes de UN cliente en 24 h que el bot atiende en WhatsApp/Messenger/
// Instagram. Una persona real casi nunca llega; corta a quien manda cientos de
// mensajes para gastar los créditos del negocio. (El chat del sitio tiene el suyo.)
export const CUSTOMER_DAILY_CAP = 100;

/** ¿Este cliente está bloqueado por el negocio? */
export function isBlocked(business, channel, id) {
  if (!id) return false;
  return (business?.blockedContacts || []).some((b) => b.channel === channel && b.id === String(id));
}

/** Identificador del cliente de una conversación según su canal. */
export function contactIdOf(chat) {
  if (!chat) return '';
  return chat.channel === 'whatsapp' ? chat.customerPhone || chat.customerId : chat.customerId;
}

/** Mensajes del cliente en las últimas 24 h dentro de la conversación. */
export function customerMessagesToday(chat, now = Date.now()) {
  const since = now - 24 * 3600 * 1000;
  return (chat?.messages || []).filter((m) => m.role === 'user' && new Date(m.timestamp).getTime() > since).length;
}
