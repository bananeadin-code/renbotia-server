import mongoose from 'mongoose';
import { BUSINESS_STATUS } from '../config/constants.js';

/**
 * Business es la unidad de aislamiento multi-tenant: todos los datos del bot,
 * consumo y chats cuelgan de un Business. En el MVP un usuario tiene un solo
 * negocio, pero el esquema ya soporta varios sin migración.
 */
const businessSchema = new mongoose.Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: [true, 'El nombre del negocio es obligatorio'],
      trim: true,
    },
    // Foto/avatar del negocio (data URI de imagen comprimida) que reemplaza el
    // avatar con la inicial en el panel. Vacío = usa la inicial.
    photo: { type: String, default: '' },
    industry: {
      type: String,
      enum: ['legal', 'contable', 'consultoria', 'agencia', 'otro'],
      default: 'otro',
    },
    // Sector personalizado cuando industry === 'otro' (ej. "Restaurante").
    industryOther: {
      type: String,
      trim: true,
      default: '',
      maxlength: 60,
    },
    whatsappNumber: {
      type: String,
      trim: true,
      default: '', // se guarda en E.164 (ej. +526181234567) tras verificar
    },
    // Verificación de propiedad del número (código OTP). Solo un número VERIFICADO
    // se considera dedicado al bot. La verificación de Meta se suma en producción.
    whatsappVerified: {
      type: Boolean,
      default: false,
    },
    whatsappVerifiedAt: {
      type: Date,
      default: null,
    },
    // ── WhatsApp Cloud API (Meta) ──
    // Id del número en Meta (metadata.phone_number_id). Es la LLAVE con la que el
    // webhook enruta cada mensaje entrante al negocio correcto. Un id pertenece a
    // un solo negocio (índice parcial único más abajo).
    whatsappPhoneNumberId: {
      type: String,
      trim: true,
      default: '',
    },
    // Id de la WhatsApp Business Account (WABA) dueña del número. Informativo.
    whatsappWabaId: {
      type: String,
      trim: true,
      default: '',
    },
    // ── Facebook Messenger (Fase 3 multicanal) ──────────────────────────────
    // Página de Facebook conectada: su id enruta el webhook, y el token de Página
    // (sensible → select:false, no sale en consultas normales) se usa para enviar.
    facebookPageId: { type: String, trim: true, default: '' }, // índice único parcial abajo
    facebookPageName: { type: String, trim: true, default: '' },
    facebookPageToken: { type: String, default: '', select: false },
    facebookConnectedAt: { type: Date, default: null },
    // ── Instagram DMs ───────────────────────────────────────────────────────
    // Cuenta profesional de Instagram ligada a una Página de Facebook. El id de
    // la cuenta (IGID) enruta el webhook; se responde con el token de la Página
    // ligada (sensible → select:false). Independiente de Messenger.
    instagramAccountId: { type: String, trim: true, default: '' }, // índice único parcial abajo
    instagramUsername: { type: String, trim: true, default: '' },
    instagramPageId: { type: String, trim: true, default: '' },
    instagramPageToken: { type: String, default: '', select: false },
    instagramConnectedAt: { type: Date, default: null },
    // ── Ajustes por canal ──
    // paused: el canal sigue conectado y los mensajes llegan a la bandeja, pero
    // el bot no contesta. iceBreakers: preguntas iniciales (Messenger/Instagram),
    // greeting: saludo de la pantalla de bienvenida de Messenger.
    channelSettings: {
      whatsapp: { paused: { type: Boolean, default: false } },
      facebook: {
        paused: { type: Boolean, default: false },
        iceBreakers: { type: [String], default: [] },
        greeting: { type: String, default: '', maxlength: 160 },
      },
      instagram: {
        paused: { type: Boolean, default: false },
        iceBreakers: { type: [String], default: [] },
      },
    },
    // Último resumen semanal "Aprende de ti" enviado al dueño.
    learningDigestAt: { type: Date, default: null },
    // ── Widget web (chat incrustable en el sitio del negocio; Pro/Elite) ──
    // `key` es PÚBLICA (va en el snippet): identifica el negocio, no da acceso al
    // panel. Se genera al activarlo y se puede regenerar para invalidar copias.
    widget: {
      enabled: { type: Boolean, default: false },
      key: { type: String, default: '' }, // índice único parcial abajo
      color: { type: String, default: '#4f46e5' },
      greeting: { type: String, default: '', maxlength: 200 },
      position: { type: String, enum: ['right', 'left'], default: 'right' },
      // Preguntas sugeridas (botones) dentro del chat.
      suggestions: { type: [String], default: [] },
      // Abrir solo tras N segundos (0 = nunca), una vez por visita.
      autoOpenSeconds: { type: Number, default: 0, min: 0, max: 120 },
      // Pedir nombre y correo/WhatsApp antes de chatear (captura de prospectos).
      requireContact: { type: Boolean, default: false },
      // Dominios donde puede usarse (vacío = cualquiera).
      allowedDomains: { type: [String], default: [] },
      hideOnMobile: { type: Boolean, default: false },
      // Texto junto al botón flotante (vacío = solo ícono).
      buttonText: { type: String, default: '', maxlength: 30 },
    },
    status: {
      type: String,
      enum: Object.values(BUSINESS_STATUS),
      default: BUSINESS_STATUS.PENDIENTE,
    },
  },
  { timestamps: true }
);

// Un número VERIFICADO no puede pertenecer a dos negocios (dedicado). El índice
// parcial solo aplica a verificados, así los números vacíos o sin verificar no
// colisionan entre sí.
businessSchema.index(
  { whatsappNumber: 1 },
  { unique: true, partialFilterExpression: { whatsappVerified: true } }
);

// Un phone_number_id de Meta pertenece a un único negocio. El índice parcial solo
// aplica a ids no vacíos, así los negocios sin conectar no colisionan entre sí.
businessSchema.index(
  { whatsappPhoneNumberId: 1 },
  { unique: true, partialFilterExpression: { whatsappPhoneNumberId: { $type: 'string', $gt: '' } } }
);

// Una Página de Facebook pertenece a un único negocio (mismo patrón que WhatsApp).
businessSchema.index(
  { facebookPageId: 1 },
  { unique: true, partialFilterExpression: { facebookPageId: { $type: 'string', $gt: '' } } }
);

// Una cuenta de Instagram pertenece a un único negocio.
businessSchema.index(
  { instagramAccountId: 1 },
  { unique: true, partialFilterExpression: { instagramAccountId: { $type: 'string', $gt: '' } } }
);

// La llave pública del widget enruta las peticiones del chat web al negocio.
businessSchema.index(
  { 'widget.key': 1 },
  { unique: true, partialFilterExpression: { 'widget.key': { $type: 'string', $gt: '' } } }
);

export const Business = mongoose.model('Business', businessSchema);
