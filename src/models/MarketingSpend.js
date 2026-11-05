import mongoose from 'mongoose';

/** Inversión mensual por canal (pauta y agencia), para calcular el costo por cliente. */
export const SPEND_CHANNELS = ['meta', 'google', 'agencia', 'otro'];

const marketingSpendSchema = new mongoose.Schema(
  {
    month: { type: String, required: true, match: /^\d{4}-\d{2}$/ }, // AAAA-MM
    channel: { type: String, enum: SPEND_CHANNELS, required: true },
    amountMXN: { type: Number, required: true, min: 0 },
    note: { type: String, default: '', maxlength: 200 },
  },
  { timestamps: true }
);
marketingSpendSchema.index({ month: 1, channel: 1 }, { unique: true });

export const MarketingSpend = mongoose.model('MarketingSpend', marketingSpendSchema);
