import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { env } from './config/env.js';
import { apiLimiter } from './middleware/rateLimit.middleware.js';
import { notFoundHandler, errorHandler } from './middleware/error.middleware.js';
import apiRoutes from './routes/index.js';
import webhookRoutes from './routes/webhook.routes.js';

/**
 * Construye la aplicación Express con todos sus middlewares y rutas.
 * Se separa de index.js para poder importarla en tests sin arrancar el server.
 */
export function createApp() {
  const app = express();

  // Confía en el proxy (necesario para rate-limit detrás de reverse proxy)
  app.set('trust proxy', 1);

  // CORS con credenciales para permitir la cookie del refresh token
  app.use(
    cors({
      origin: env.clientUrl,
      credentials: true,
    })
  );

  // Límite amplio: el entrenamiento del bot (Elite) puede incluir hasta 15
  // imágenes embebidas como data URI comprimido dentro del JSON.
  // Guardamos el body crudo para poder verificar la firma HMAC del webhook de
  // WhatsApp (Meta firma el payload con el App Secret sobre los bytes exactos).
  app.use(
    express.json({
      limit: '12mb',
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );
  app.use(express.urlencoded({ extended: true, limit: '12mb' }));
  app.use(cookieParser());

  // Webhook de WhatsApp (Meta llama directo): fuera de /api y de su rate-limit.
  app.use('/webhooks/whatsapp', webhookRoutes);

  // Rate limit general para toda la API
  app.use('/api', apiLimiter);

  // Rutas
  app.use('/api', apiRoutes);

  // 404 + manejo de errores centralizado (siempre al final)
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
