import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';
import { isProd } from '../config/env.js';

/**
 * 404 para rutas no encontradas. Se monta después de todas las rutas.
 */
export function notFoundHandler(req, res, next) {
  next(ApiError.notFound(`Ruta no encontrada: ${req.method} ${req.originalUrl}`));
}

/**
 * Manejo de errores centralizado. Traduce cualquier error a una respuesta
 * JSON uniforme: { success: false, message, details? }.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Error interno del servidor';
  let details = err.details || null;

  // Errores de validación de Mongoose
  if (err.name === 'ValidationError') {
    statusCode = 400;
    message = 'Datos inválidos';
    details = Object.values(err.errors).map((e) => e.message);
  }

  // Clave duplicada (p.ej. email ya registrado)
  if (err.code === 11000) {
    statusCode = 409;
    const field = Object.keys(err.keyValue || {})[0] || 'campo';
    message = `Ya existe un registro con ese ${field}`;
  }

  // CastError (ObjectId inválido)
  if (err.name === 'CastError') {
    statusCode = 400;
    message = `Identificador inválido: ${err.value}`;
  }

  // Errores de JWT
  if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    message = 'Token inválido';
  }
  if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Token expirado';
  }

  // Los errores 5xx son bugs inesperados: log con stack completo.
  if (statusCode >= 500) {
    logger.error(`${req.method} ${req.originalUrl} → ${err.stack || err.message}`);
  } else {
    logger.warn(`${req.method} ${req.originalUrl} → ${statusCode} ${message}`);
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(details ? { details } : {}),
    ...(isProd ? {} : { stack: err.stack }),
  });
}
