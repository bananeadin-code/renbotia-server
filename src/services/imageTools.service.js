/**
 * Herramienta (tool use) para que el bot ENVÍE imágenes reales del negocio
 * (menú, catálogo, planes, etc.) en lugar de escribir un placeholder de texto.
 * Solo aplica a Elite con imágenes configuradas (nombre + fuente).
 */

/** Imágenes utilizables: deben tener nombre y fuente (url http o data URI). */
export function usableImages(botConfig) {
  return (botConfig?.images || []).filter((img) => img.label?.trim() && img.url?.trim());
}

/** Define la herramienta enviar_imagen con el enum de nombres disponibles. */
export function buildImageTool(images) {
  const names = images.map((i) => i.label.trim());
  return {
    name: 'enviar_imagen',
    description:
      'Envía al cliente una de las imágenes disponibles del negocio (por ejemplo menú, catálogo, lista de planes, ubicación). ' +
      'Úsala cuando el cliente pida ver algo que corresponda a una imagen o cuando ofrecértela sea útil. ' +
      'Solo puedes enviar las imágenes de la lista; no inventes otras.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: {
          type: 'string',
          enum: names,
          description: 'Nombre exacto de la imagen a enviar (uno de la lista).',
        },
      },
      required: ['nombre'],
    },
  };
}

/**
 * Ejecuta enviar_imagen: busca la imagen por nombre (sin distinguir mayúsculas).
 * @returns {{ result: object, image?: {label,url} }}
 */
export function executeImageTool(input, images) {
  const name = String(input?.nombre || '').trim().toLowerCase();
  const img = images.find((i) => i.label.trim().toLowerCase() === name);
  if (!img) {
    return { result: { ok: false, error: 'Esa imagen no está disponible.' } };
  }
  return {
    result: { ok: true, mensaje: `Imagen "${img.label.trim()}" enviada al cliente.` },
    image: { label: img.label.trim(), url: img.url.trim() },
  };
}
