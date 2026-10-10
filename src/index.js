import { createApp } from './app.js';
import { installProcessAlerts } from './services/alert.service.js';
import { connectDB } from './config/db.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { startFollowUpScheduler } from './services/followUp.service.js';
import { startBackupScheduler } from './services/backup.service.js';
import { startWeeklyReportScheduler } from './services/weeklyReport.service.js';
import { startRenewalScheduler } from './services/renewal.service.js';
import { encryptLegacySecrets } from './services/encryptSecrets.service.js';
import { syncPlans } from './services/syncPlans.service.js';
import { backfillRecordChannels } from './services/management.service.js';

/**
 * Punto de entrada: conecta a la base de datos y arranca el servidor HTTP.
 */
async function start() {
  installProcessAlerts();
  await connectDB();

  // Precios y beneficios de los planes = los del código (los que se cobran).
  await syncPlans().catch((err) => logger.error(`Sincronizar planes: ${err.message}`));

  // Cifra tokens de Página guardados en claro (idempotente, no bloquea el arranque).
  encryptLegacySecrets().catch((err) => logger.error(`Cifrado de tokens: ${err.message}`));

  // Canal de origen en registros de Gestión anteriores (idempotente, no bloquea).
  backfillRecordChannels().catch((err) => logger.error(`Canal de registros: ${err.message}`));

  const app = createApp();

  const server = app.listen(env.port, () => {
    logger.info(`Servidor escuchando en http://localhost:${env.port} (${env.nodeEnv})`);
  });

  // Seguimiento automático a clientes que dejaron de responder (Pro/Elite).
  startFollowUpScheduler();
  // Respaldo cifrado por correo (gratis, mientras no haya backups de Atlas).
  startBackupScheduler();
  // Reporte semanal del lunes al dueño (resultados en pesos, leads y pendientes).
  startWeeklyReportScheduler();
  // Renovación mensual con cobro a la tarjeta guardada (Pro/Elite).
  startRenewalScheduler();

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
