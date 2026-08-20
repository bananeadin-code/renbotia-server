/**
 * Logger minimalista con nivel y timestamp.
 * Suficiente para el MVP; a producción se puede cambiar por pino/winston
 * sin tocar los call-sites (misma interfaz: info/warn/error/debug).
 */
const ts = () => new Date().toISOString();

const format = (level, msg) => `[${ts()}] [${level}] ${msg}`;

export const logger = {
  info: (msg) => console.log(format('INFO', msg)),
  warn: (msg) => console.warn(format('WARN', msg)),
  error: (msg) => console.error(format('ERROR', msg)),
  debug: (msg) => {
    if (process.env.NODE_ENV !== 'production') {
      console.debug(format('DEBUG', msg));
    }
  },
};
