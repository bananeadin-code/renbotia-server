import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { ROLES } from '../config/constants.js';

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'El nombre es obligatorio'],
      trim: true,
    },
    email: {
      type: String,
      required: [true, 'El email es obligatorio'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Email inválido'],
    },
    passwordHash: {
      type: String,
      // No obligatorio: las cuentas creadas con Google no tienen contraseña.
      select: false, // no se devuelve por defecto en las consultas
    },
    // Cuentas vinculadas con Google (Sign in with Google). sparse: solo indexa
    // los documentos que lo tienen, así los usuarios con email/contraseña no chocan.
    googleId: {
      type: String,
      index: { unique: true, sparse: true },
      select: false,
    },
    role: {
      type: String,
      enum: Object.values(ROLES),
      default: ROLES.CLIENTE,
    },
    // Flujo de recuperación de contraseña
    resetToken: { type: String, select: false },
    resetTokenExpiry: { type: Date, select: false },
    // Verificación de correo: las cuentas con contraseña deben confirmar un código
    // enviado al email antes de activarse. Las de Google llegan ya verificadas.
    emailVerified: { type: Boolean, default: false },
    // 2FA por email al iniciar sesión (solo cuentas con contraseña). Activo por
    // defecto; el usuario podrá desactivarlo desde su perfil más adelante.
    twoFactorEnabled: { type: Boolean, default: true },
  },
  { timestamps: true }
);

/**
 * Método de instancia para fijar la contraseña generando el hash.
 * Se usa en registro y en cambio de contraseña.
 */
userSchema.methods.setPassword = async function setPassword(plain) {
  const salt = await bcrypt.genSalt(10);
  this.passwordHash = await bcrypt.hash(plain, salt);
};

userSchema.methods.comparePassword = function comparePassword(plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

/**
 * Serialización segura: nunca expone el hash ni los tokens de reset.
 */
userSchema.methods.toJSON = function toJSON() {
  const obj = this.toObject();
  delete obj.passwordHash;
  delete obj.googleId;
  delete obj.resetToken;
  delete obj.resetTokenExpiry;
  delete obj.__v;
  return obj;
};

export const User = mongoose.model('User', userSchema);
