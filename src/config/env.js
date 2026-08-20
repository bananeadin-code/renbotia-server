import dotenv from 'dotenv';

dotenv.config();

/**
 * Carga y valida las variables de entorno una sola vez.
 * Si falta una variable crítica, aborta el arranque con un mensaje claro
 * en lugar de fallar de forma confusa más adelante.
 */
const required = [
  'MONGODB_URI',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  // eslint-disable-next-line no-console
  console.error(
    `\n[ENV] Faltan variables de entorno obligatorias: ${missing.join(', ')}\n` +
      'Copia server/.env.example a server/.env y complétalas.\n'
  );
  process.exit(1);
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 5000,
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',

  mongoUri: process.env.MONGODB_URI,

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessExpires: process.env.JWT_ACCESS_EXPIRES || '15m',
    refreshExpires: process.env.JWT_REFRESH_EXPIRES || '7d',
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-5',
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    // Clave PUBLICABLE (pk_test_…): no es secreta, se envía al cliente para
    // inicializar Stripe.js/Elements. Ponla en server/.env junto a la secreta.
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  },

  // Inicio de sesión con Google (Sign in with Google). GOOGLE_CLIENT_ID es el
  // "Client ID" del proyecto en Google Cloud (credencial OAuth 2.0, tipo Web).
  // No es secreto (se envía al cliente para inicializar el botón). Si falta, el
  // botón "Continuar con Google" no se muestra.
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
  },

  // Envío de emails transaccionales (comprobantes de compra) vía Resend.
  // RESEND_API_KEY: clave de tu cuenta Resend. EMAIL_FROM: remitente verificado
  // en tu dominio (ej. "RenBotIA <facturacion@tudominio.com>"). Si falta la key,
  // el envío se omite silenciosamente (el resto del flujo no se rompe).
  resend: {
    apiKey: process.env.RESEND_API_KEY || '',
    from: process.env.EMAIL_FROM || 'RenBotIA <onboarding@resend.dev>',
    replyTo: process.env.EMAIL_REPLY_TO || '',
  },

  // URL pública del sitio para enlaces dentro de los emails.
  publicUrl: process.env.PUBLIC_URL || process.env.CLIENT_URL || 'http://localhost:5173',
};

export const isProd = env.nodeEnv === 'production';
