import { ApiError } from '../utils/ApiError.js';

/**
 * Middleware de validación con Zod. Recibe un esquema y valida req.body.
 * Reemplaza req.body con los datos parseados (ya con tipos correctos).
 *
 *   router.post('/', validate(registerSchema), controller);
 */
export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const details = result.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      }));
      return next(ApiError.badRequest('Datos inválidos', details));
    }
    req.body = result.data;
    next();
  };
}
