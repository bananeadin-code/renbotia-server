import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

/**
 * Establece la conexión con MongoDB vía Mongoose.
 * Se llama una vez al arrancar el servidor.
 */
export async function connectDB() {
  mongoose.set('strictQuery', true);

  try {
    const conn = await mongoose.connect(env.mongoUri);
    logger.info(`MongoDB conectado: ${conn.connection.host}/${conn.connection.name}`);
  } catch (err) {
    logger.error(`Error al conectar con MongoDB: ${err.message}`);
    process.exit(1);
  }

  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB desconectado');
  });
}
