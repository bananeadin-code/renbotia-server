/**
 * Envuelve un controlador async para capturar errores y pasarlos a next(),
 * evitando try/catch repetido en cada handler.
 *
 *   router.get('/', asyncHandler(async (req, res) => { ... }));
 */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
