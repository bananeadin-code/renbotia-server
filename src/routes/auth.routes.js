import { Router } from 'express';
import { validate } from '../middleware/validate.middleware.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { authLimiter } from '../middleware/rateLimit.middleware.js';
import * as auth from '../controllers/auth.controller.js';

const router = Router();

// Rutas públicas (con rate limit estricto anti fuerza bruta)
router.post('/register', authLimiter, validate(auth.registerSchema), auth.register);
router.post('/login', authLimiter, validate(auth.loginSchema), auth.login);
router.post('/google', authLimiter, validate(auth.googleSchema), auth.googleAuth);

// Verificación de correo (registro) y 2FA de login por código de 6 dígitos.
router.post('/verify-email', authLimiter, validate(auth.verifyEmailSchema), auth.verifyEmail);
router.post('/verify-2fa', authLimiter, validate(auth.verify2faSchema), auth.verify2fa);
router.post('/resend-code', authLimiter, validate(auth.resendCodeSchema), auth.resendCode);
router.get('/config', auth.getAuthConfig); // Client ID de Google (público)
router.post('/refresh', auth.refresh);
router.post('/logout', auth.logout);

// Recuperación de contraseña (simulada, sin email real)
router.post('/forgot-password', authLimiter, validate(auth.forgotSchema), auth.forgotPassword);
router.post('/reset-password', authLimiter, validate(auth.resetSchema), auth.resetPassword);

// Rutas protegidas: datos del usuario autenticado + ajustes de seguridad
router.get('/me', requireAuth, auth.me);
router.patch('/2fa', requireAuth, validate(auth.twoFactorSchema), auth.updateTwoFactor);

export default router;
