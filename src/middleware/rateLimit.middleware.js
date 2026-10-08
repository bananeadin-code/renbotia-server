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
 * contactLimiter: formulario de contacto PÚBLICO. Estricto para cortar spam de
 * bots sin molestar a una persona real (5 envíos por IP cada 15 min).
 */
export const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Recibimos varios mensajes tuyos. Espera un momento antes de enviar otro.',
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

/**
 * widgetLimiter: chat web PÚBLICO incrustado en sitios de clientes. Cada mensaje
 * consume créditos del negocio, así que se acota por IP (un visitante real no
 * escribe 30 mensajes en 5 minutos).
 */
export const widgetLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Estás enviando mensajes muy rápido. Espera un momento.',
  },
});

/**
 * demoProfileLimiter: "Pruébalo con tu negocio" lee un sitio y llama a Claude para
 * armar el perfil. Pocas veces por IP (una persona real lo hace 1 o 2 veces).
 */
export const demoProfileLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Ya generaste varias demos. Crea tu cuenta gratis para seguir con tu propio bot.',
  },
});


/**
 * dailyBudget: tope GLOBAL por día (todas las IPs juntas) para endpoints públicos
 * que gastan IA a costo de RenBotIA. Los límites por IP no bastan: detrás del
 * proxy de Vercel la IP puede rotar, y un abuso distribuido los esquiva. En
 * memoria (una sola instancia); se reinicia a medianoche UTC o al reiniciar.
 */
export function dailyBudget(max, message) {
  let day = '';
  let used = 0;
  return (req, res, next) => {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      used = 0;
    }
    if (used >= max) {
      return res.status(429).json({ success: false, message, code: 'DAILY_BUDGET' });
    }
    used += 1;
    return next();
  };
}

export const demoDailyBudget = dailyBudget(
  Number(process.env.DEMO_DAILY_MAX) || 500,
  'La demo está muy solicitada hoy. Crea tu cuenta gratis para probar tu propio bot.'
);
export const siteAssistantDailyBudget = dailyBudget(
  Number(process.env.SITE_ASSISTANT_DAILY_MAX) || 500,
  'El asistente está muy solicitado hoy. Escríbenos desde Contacto y te respondemos.'
);
export const demoProfileDailyBudget = dailyBudget(
  Number(process.env.DEMO_PROFILE_DAILY_MAX) || 50,
  'La demo está muy solicitada hoy. Crea tu cuenta gratis para probar tu propio bot.'
);
