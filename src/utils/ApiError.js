/**
 * Error de aplicación con código HTTP consistente.
 * Los controladores lanzan `throw new ApiError(404, 'No encontrado')`
 * y el middleware de errores central lo traduce a una respuesta JSON uniforme.
 */
export class ApiError extends Error {
  constructor(statusCode, message, details = null) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = true; // distingue errores esperados de bugs
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(msg, details) {
    return new ApiError(400, msg, details);
  }

  static unauthorized(msg = 'No autenticado') {
    return new ApiError(401, msg);
  }

  static forbidden(msg = 'No autorizado') {
    return new ApiError(403, msg);
  }

  static notFound(msg = 'Recurso no encontrado') {
    return new ApiError(404, msg);
  }

  static conflict(msg) {
    return new ApiError(409, msg);
  }
}
