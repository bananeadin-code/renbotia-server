import mongoose from 'mongoose';
import { CONVERSATION_RETENTION_DAYS } from '../config/constants.js';

/**
 * Archivo que un cliente envió en una conversación (hoy: PDF). Va APARTE del
 * documento de la conversación para no inflarlo (Mongo limita cada documento a
 * 16 MB); el mensaje solo guarda {id, name, mime, size}. Se borra solo con la
 * misma retención que las conversaciones.
 */
const chatAttachmentSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    chat: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatSimulation', required: true, index: true },
    name: { type: String, default: 'documento.pdf', maxlength: 200 },
    mime: { type: String, required: true },
    size: { type: Number, required: true },
    data: { type: Buffer, required: true },
  },
  { timestamps: true }
);

chatAttachmentSchema.index({ createdAt: 1 }, { expireAfterSeconds: CONVERSATION_RETENTION_DAYS * 24 * 60 * 60 });

export const ChatAttachment = mongoose.model('ChatAttachment', chatAttachmentSchema);
