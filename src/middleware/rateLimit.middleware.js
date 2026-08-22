import rateLimit from 'express-rate-limit';

/**
 * Rate limiting básico para evitar abuso.
 * - apiLimiter: límite general para todas las rutas /api.
 * - authLimiter: más estricto en login/registro (anti fuerza bruta).
 * - simulatorLimiter: protege el endpoint que llama a Claude (coste real).
 */
export const apiLimiter = rateLimit({
  // Límite general por IP. Amplio: un panel SPA hace varias llamadas por vista
  // (negocio, suscripción, proyectos, conversaciones, config del asistente…),
  // así que 300/15min se quedaba corto al navegar rápido. 1000/15min corta abuso
  // sin molestar el uso normal ni las auditorías.
  windowMs: 15 * 60 * 1000, // 15 min
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Demasiadas peticiones, intenta más tarde' },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Demasiados intentos de autenticación, intenta más tarde',
  },
});

export const simulatorLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Estás enviando mensajes muy rápido, espera un momento',
  },
});

/**
 * demoLimiter: la demo PÚBLICA (sin registro) llama a Claude, que cuesta dinero.
 * Límite estricto por IP para permitir probarla de verdad pero cortar el abuso.
 */
export const demoLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 min
  max: 15, // mensajes por IP en la ventana
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Probaste la demo bastante. Crea una cuenta gratis para seguir con tu propio bot.',
  },
});
