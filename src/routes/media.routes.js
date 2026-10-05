import { Router } from 'express';
import mongoose from 'mongoose';
import { BotConfig } from '../models/BotConfig.js';

/**
 * Medios públicos del bot. Instagram (y cualquier canal que pida URL) descarga de
 * aquí las imágenes que el negocio subió al panel, que se guardan como data URI.
 * Solo expone imágenes que el propio negocio cargó para enviarlas a sus clientes;
 * se identifican por su ObjectId (no adivinable).
 */
const router = Router();

router.get('/bot-image/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.sendStatus(404);
    const cfg = await BotConfig.findOne({ 'images._id': id }, { 'images.$': 1 }).lean();
    const img = cfg?.images?.[0];
    const src = img?.url || '';
    if (/^https?:\/\//i.test(src)) return res.redirect(302, src);
    const m = /^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/s.exec(src);
    if (!m) return res.sendStatus(404);
    res.set('Content-Type', m[1]);
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(Buffer.from(m[2], 'base64'));
  } catch (err) {
    next(err);
  }
});

export default router;
