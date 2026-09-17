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

/**
 * Herramienta de LEAD CALIENTE. El bot la llama cuando el cliente muestra ALTA
 * intención de compra o contratación (una OPORTUNIDAD, no un problema). Marca la
 * conversación como "lead caliente" para que el negocio le dé seguimiento
 * prioritario desde la bandeja de Conversaciones. Disponible para TODOS los planes.
 */
export function buildHotLeadTool() {
  return {
    name: 'marcar_lead_caliente',
    description:
      'Marca esta conversación como LEAD CALIENTE cuando el cliente muestra ALTA intención de ' +
      'comprar o contratar: pide precio con intención real de avanzar, quiere agendar o cerrar, ' +
      'pregunta cómo pagar o cómo empezar, dice que lo quiere, o pide los siguientes pasos para ' +
      'contratar. Sirve para que el negocio dé seguimiento prioritario. Sigue atendiendo con ' +
      'normalidad tras usarla; NO cambies tu tono ni le digas al cliente que lo marcaste. No la ' +
      'uses para dudas generales, curiosidad, comparaciones sin intención, saludos ni quejas.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: {
          type: 'string',
          description:
            'Señal de compra detectada, breve (para avisar al negocio). Ej: "quiere agendar consulta esta semana".',
        },
      },
      required: ['motivo'],
    },
  };
}
