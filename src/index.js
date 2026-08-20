import { createApp } from './app.js';
import { connectDB } from './config/db.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';

/**
 * Punto de entrada: conecta a la base de datos y arranca el servidor HTTP.
 */
async function start() {
  await connectDB();

  const app = createApp();

  const server = app.listen(env.port, () => {
    logger.info(`Servidor escuchando en http://localhost:${env.port} (${env.nodeEnv})`);
  });

  // Apagado ordenado
  const shutdown = (signal) => {
    logger.warn(`Recibida señal ${signal}, cerrando servidor...`);
    server.close(() => {
      logger.info('Servidor cerrado');
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((err) => {
  logger.error(`Fallo al arrancar: ${err.stack || err.message}`);
  process.exit(1);
});
