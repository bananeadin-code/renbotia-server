/**
 * Herramienta de ESCALACIÓN a humano. El bot la llama cuando debe entrar una
 * persona: el cliente pide hablar con un humano, presenta una queja seria, un
 * tema urgente o algo que el bot no puede resolver. Marca la conversación como
 * "requiere atención" para que aparezca en la bandeja de Conversaciones.
 *
 * Disponible para TODOS los planes (el módulo de Conversaciones no está limitado
 * por plan; lo limitado por plan es tener colaboradores).
 */
export function buildEscalationTool() {
  return {
    name: 'escalar_a_humano',
    description:
      'Marca esta conversación para que la atienda una PERSONA. Úsala cuando el cliente pida ' +
      'explícitamente hablar con un humano/asesor, cuando exprese una queja seria o un tema ' +
      'urgente, o cuando te pida algo que no puedas resolver con la información del negocio. ' +
      'Tras usarla, responde con cortesía que en un momento lo atenderá una persona. No la uses ' +
      'para saludos, agradecimientos ni dudas normales que sí puedes responder.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: {
          type: 'string',
          description: 'Motivo breve por el que se necesita una persona (para avisar al negocio).',
        },
      },
      required: ['motivo'],
    },
  };
}
