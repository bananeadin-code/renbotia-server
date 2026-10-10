import mongoose from 'mongoose';

/**
 * Llave de acceso (passkey / WebAuthn) de un usuario: entra con la huella, la
 * cara o el PIN de su dispositivo. Solo guardamos la llave PÚBLICA; la privada
 * nunca sale del dispositivo, así que no hay nada que robar de la base.
 */
const passkeySchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    credentialId: { type: String, required: true, unique: true }, // base64url
    publicKey: { type: String, required: true }, // base64url (COSE)
    counter: { type: Number, default: 0 },
    transports: { type: [String], default: [] },
    name: { type: String, default: 'Llave de acceso', maxlength: 60 },
    deviceType: { type: String, default: '' }, // singleDevice | multiDevice (sincronizada)
    backedUp: { type: Boolean, default: false },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const Passkey = mongoose.model('Passkey', passkeySchema);
