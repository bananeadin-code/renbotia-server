import mongoose from 'mongoose';

/**
 * Catálogo de planes. Se puebla desde config/constants.js vía el seed.
 * No lo crea el usuario final.
 */
const planSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      enum: ['free', 'pro', 'elite'],
      required: true,
      unique: true,
    },
    name: { type: String, required: true },
    priceMXN: { type: Number, required: true, min: 0 },
    monthlyTokenLimit: { type: Number, required: true, min: 0 },
    highlights: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const Plan = mongoose.model('Plan', planSchema);
