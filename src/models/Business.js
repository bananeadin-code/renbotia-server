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

export const Business = mongoose.model('Business', businessSchema);
