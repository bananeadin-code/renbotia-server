import { Router } from 'express';
import { requireHuman } from '../middleware/turnstile.middleware.js';
import { requireRecentAuth } from '../middleware/stepUp.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { authLimiter } from '../middleware/rateLimit.middleware.js';
import * as auth from '../controllers/auth.controller.js';

const router = Router();

// Rutas públicas (con rate limit estricto anti fuerza bruta)
router.post('/register', authLimiter, requireHuman, validate(auth.registerSchema), auth.register);
router.post('/login', authLimiter, validate(auth.loginSchema), auth.login);
router.post('/google', authLimiter, validate(auth.googleSchema), auth.googleAuth);

// Verificación de correo (registro) y 2FA de login por código de 6 dígitos.
router.post('/verify-email', authLimiter, validate(auth.verifyEmailSchema), auth.verifyEmail);
router.post('/verify-2fa', authLimiter, validate(auth.verify2faSchema), auth.verify2fa);
router.post('/resend-code', authLimiter, validate(auth.resendCodeSchema), auth.resendCode);
router.get('/config', auth.getAuthConfig); // Client ID de Google (público)
router.post('/refresh', auth.refresh);
// Contexto: elegir a qué entrar tras el login, cambiar de proyecto, listar.
router.post('/context/select', authLimiter, validate(auth.selectContextSchema), auth.selectContext);
router.post('/context/switch', requireAuth, validate(auth.switchContextSchema), auth.switchContext);
router.get('/contexts', requireAuth, auth.getContexts);
// Confirmar identidad para acciones delicadas (10 min).
router.post('/step-up', requireAuth, authLimiter, validate(auth.stepUpSchema), auth.stepUp);
router.post('/step-up/code', requireAuth, authLimiter, auth.stepUpCode);
router.post('/step-up/passkey/options', requireAuth, authLimiter, auth.stepUpPasskeyOptions);
router.post('/step-up/passkey/verify', requireAuth, authLimiter, validate(auth.passkeyVerifySchema), auth.stepUpPasskeyVerify);

// Llaves de acceso (passkeys): entrar con huella, cara o PIN del dispositivo.
router.post('/passkeys/login/options', authLimiter, auth.passkeyLoginOptions);
router.post('/passkeys/login/verify', authLimiter, validate(auth.passkeyVerifySchema), auth.passkeyLoginVerify);
router.get('/passkeys', requireAuth, auth.getPasskeys);
router.post('/passkeys/register/options', requireAuth, requireRecentAuth, auth.passkeyRegisterOptions);
router.post('/passkeys/register/verify', requireAuth, requireRecentAuth, validate(auth.passkeyVerifySchema), auth.passkeyRegisterVerify);
router.patch('/passkeys/:id', requireAuth, validate(auth.passkeyRenameSchema), auth.renamePasskey);
router.delete('/passkeys/:id', requireAuth, requireRecentAuth, auth.deletePasskey);
router.post('/logout', auth.logout);

// Recuperación de contraseña (enlace de un solo uso por correo)
router.post('/forgot-password', authLimiter, requireHuman, validate(auth.forgotSchema), auth.forgotPassword);
router.post('/reset-password', authLimiter, validate(auth.resetSchema), auth.resetPassword);

// Rutas protegidas: datos del usuario autenticado + ajustes de seguridad
router.get('/me', requireAuth, auth.me);
router.patch('/profile', requireAuth, validate(auth.updateProfileSchema), auth.updateProfile);
router.patch('/2fa', requireAuth, requireRecentAuth, validate(auth.twoFactorSchema), auth.updateTwoFactor);
// Sesiones activas (Perfil → Seguridad): ver, cerrar una o cerrar las demás.
router.get('/sessions', requireAuth, auth.getSessions);
router.get('/security', requireAuth, auth.getSecurityOverview);
router.post('/sessions/revoke-others', requireAuth, auth.revokeOtherSessions);
router.delete('/sessions/:id', requireAuth, auth.deleteSession);
// Cambio de correo con re-verificación (código al correo nuevo).
router.post('/email/request', requireAuth, requireRecentAuth, authLimiter, validate(auth.requestEmailChangeSchema), auth.requestEmailChange);
router.post('/email/verify', requireAuth, authLimiter, validate(auth.verifyEmailChangeSchema), auth.verifyEmailChange);
// Eliminación de cuenta (con rate limit: reautentica con contraseña).
router.delete('/account', requireAuth, authLimiter, validate(auth.deleteAccountSchema), auth.deleteAccount);

export default router;
