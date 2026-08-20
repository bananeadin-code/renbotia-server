/**
 * Catálogo de planes y paquetes de créditos.
 * El seed usa PLANS para poblar la colección `Plan`.
 * Los precios están en MXN. Los límites de tokens son mensuales.
 */
export const PLANS = [
  {
    key: 'free',
    name: 'Free',
    priceMXN: 0,
    monthlyTokenLimit: 50_000,
    highlights: [
      'Simulador de WhatsApp',
      'Hasta 2 preguntas frecuentes',
      'Datos del negocio',
      'Tono neutral (sin personalización)',
    ],
  },
  {
    key: 'pro',
    name: 'Pro',
    priceMXN: 429,
    monthlyTokenLimit: 1_000_000,
    highlights: [
      'Todo lo de Free',
      'Hasta 10 preguntas frecuentes',
      'Instrucciones de personalidad y tono',
      'Contexto ampliado (prompt libre del negocio)',
    ],
  },
  {
    key: 'elite',
    name: 'Elite',
    priceMXN: 999,
    monthlyTokenLimit: 5_000_000,
    highlights: [
      'Todo lo de Pro',
      'Preguntas frecuentes ilimitadas',
      'Envío autónomo de imágenes (hasta 15, con contexto)',
      'Entrenamiento y conocimiento ampliado',
    ],
  },
];

/**
 * Capacidades del panel de entrenamiento por plan. `maxFaqs: null` = ilimitado.
 * El backend sanea la BotConfig contra estos límites (fuente de verdad) y el
 * frontend los replica para mostrar/ocultar campos.
 */
export const PLAN_LIMITS = {
  free: { maxFaqs: 2, personality: false, tone: false, extraContext: false, maxImages: 0, management: false, multiUser: false },
  pro: { maxFaqs: 10, personality: true, tone: true, extraContext: true, maxImages: 0, management: false, multiUser: true },
  elite: { maxFaqs: null, personality: true, tone: true, extraContext: true, maxImages: 15, management: true, multiUser: true },
};

/**
 * Módulo de Gestión (solo Elite). El bot capta trabajo (citas, reservaciones,
 * pedidos, prospectos) y el cliente lo gestiona en su panel.
 */
export const RECORD_TYPES = {
  CITA: 'cita',
  RESERVACION: 'reservacion',
  PEDIDO: 'pedido',
  PROSPECTO: 'prospecto',
};

// Metadatos por tipo. `scheduled` = ocupa un espacio en la agenda (requiere
// fecha/hora y valida disponibilidad). pedido/prospecto no bloquean agenda.
export const RECORD_TYPE_META = {
  cita: { label: 'Cita', scheduled: true },
  reservacion: { label: 'Reservación', scheduled: true },
  pedido: { label: 'Pedido', scheduled: false },
  prospecto: { label: 'Prospecto', scheduled: false },
};

export const RECORD_STATUS = {
  PENDIENTE: 'pendiente',
  CONFIRMADO: 'confirmado',
  COMPLETADO: 'completado',
  CANCELADO: 'cancelado',
};

// Estados que "ocupan" un espacio en la agenda (cuentan para la capacidad).
export const ACTIVE_RECORD_STATUSES = ['pendiente', 'confirmado'];

/**
 * Configuración de disponibilidad por defecto al activar el módulo.
 * schedule: 0=domingo … 6=sábado. Lun–Vie 9–18 por defecto.
 */
export const DEFAULT_MANAGEMENT_CONFIG = {
  enabled: false,
  enabledTypes: ['cita'],
  slotMinutes: 60,
  capacityPerSlot: 1,
  leadTimeHours: 2,
  horizonDays: 30,
  schedule: [
    { day: 0, enabled: false, open: '09:00', close: '18:00' },
    { day: 1, enabled: true, open: '09:00', close: '18:00' },
    { day: 2, enabled: true, open: '09:00', close: '18:00' },
    { day: 3, enabled: true, open: '09:00', close: '18:00' },
    { day: 4, enabled: true, open: '09:00', close: '18:00' },
    { day: 5, enabled: true, open: '09:00', close: '18:00' },
    { day: 6, enabled: false, open: '09:00', close: '14:00' },
  ],
  blackoutDates: [],
  timezone: 'America/Mexico_City',
};

/**
 * Paquetes de créditos adicionales (tokens que se acumulan en extraTokens,
 * NO se resetean en la renovación mensual).
 */
export const CREDIT_PACKS = [
  { key: 'pack_100k', name: '100 mil créditos', tokens: 100_000, priceMXN: 129 },
  { key: 'pack_500k', name: '500 mil créditos', tokens: 500_000, priceMXN: 399 },
  { key: 'pack_1m', name: '1 millón de créditos', tokens: 1_000_000, priceMXN: 529 },
  { key: 'pack_3m', name: '3 millones de créditos', tokens: 3_000_000, priceMXN: 1199 },
];

/**
 * Precios de la API de Anthropic (claude-sonnet-5), USD por millón de tokens.
 * Usamos el precio ESTÁNDAR como estimación conservadora (el intro hasta
 * 2026-08-31 es más barato: $2 input / $10 output, así que el costo real hoy es
 * MENOR que el estimado). Cache: la escritura con TTL de 1 HORA cuesta 2x input
 * (=$6/M); la lectura 0.1x input (=$0.30/M). El system prompt se cachea a 1h
 * (ver SYSTEM_CACHE_CONTROL en claude.service), por eso cacheWritePerM = 2x.
 * Ajusta estos valores si cambias de modelo, de TTL o de precios.
 */
export const PRICING = {
  inputPerM: 3.0,
  outputPerM: 15.0,
  cacheWritePerM: 6.0, // 2x input (TTL 1h). Con TTL 5min sería 3.75 (1.25x).
  cacheReadPerM: 0.3, // 0.1x input
};

// Tipo de cambio aproximado para mostrar el costo también en MXN.
export const USD_TO_MXN = 18;

/**
 * Pesos para descontar créditos al CLIENTE aprovechando el caché.
 * El prompt del sistema (configuración + entrenamiento) es un único bloque
 * cacheado que solo se reconstruye cuando el cliente edita su bot. Así:
 *  - input / cacheCreation: cuentan completo (1×). La 1ª vez tras editar se
 *    "escribe" el caché (cacheCreation) y cuenta como entrada normal.
 *  - cacheRead: el config/entrenamiento reutilizado cuenta a MITAD (0.5×) —
 *    PUNTO MEDIO: el ahorro del caché se reparte entre el cliente (paga menos)
 *    y la plataforma (no infla tanto el consumo del cupo). El costo REAL de esa
 *    lectura es 0.1×; cobrar 0.5× deja al cliente un buen descuento sin regalar
 *    todo el margen.
 *  - output: completo.
 * No cambia lo que se guarda para el costo real (UsageLog); solo lo que se
 * descuenta de la billetera del cliente.
 */
export const WALLET_TOKEN_WEIGHTS = {
  input: 1,
  cacheCreation: 1,
  cacheRead: 0.5,
  output: 1,
};

export const ROLES = {
  CLIENTE: 'cliente',
  ADMIN: 'admin',
};

export const BUSINESS_STATUS = {
  PENDIENTE: 'pendiente',
  ACTIVO: 'activo',
  SUSPENDIDO: 'suspendido',
};

export const SUBSCRIPTION_STATUS = {
  ACTIVA: 'activa',
  VENCIDA: 'vencida',
  CANCELADA: 'cancelada',
};
