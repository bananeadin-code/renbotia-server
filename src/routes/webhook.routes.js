import { Router } from 'express';
import { verifyWebhook, receiveWebhook } from '../controllers/webhook.controller.js';

/**
 * Webhook público de WhatsApp Cloud API. Meta llama directamente a este servidor
 * (no pasa por el proxy del frontend), así que vive fuera de /api y de su rate-limit.
 *   URL a registrar en Meta: https://<tu-backend>/webhooks/whatsapp
 */
const router = Router();

router.get('/', verifyWebhook); // verificación (hub.challenge)
router.post('/', receiveWebhook); // recepción de mensajes

export default router;
