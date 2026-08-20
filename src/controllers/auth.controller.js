import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import * as authService from '../services/auth.service.js';
import { env, isProd } from '../config/env.js';

/**
 * Esquemas de validación (Zod). Se exportan para usarse en las rutas.
 */
export const registerSchema = z.object({
  name: z.string().min(2, 'El nombre debe tener al menos 2 caracteres'),
  email: z.string().email('Email inválido'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
});

export const loginSchema = z.object({
  email: z.string().email('Email inválido'),
  password: z.string().min(1, 'La contraseña es obligatoria'),
});

export const forgotSchema = z.object({
  email: z.string().email('Email inválido'),
});

export const resetSchema = z.object({
  token: z.string().min(10, 'Token inválido'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
});

// El refresh token se guarda en cookie httpOnly para no exponerlo a JS del cliente.
const refreshCookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 días
  path: '/api/auth',
};

function sendAuthResponse(res, { user, accessToken, refreshToken }, status = 200) {
  res.cookie('refreshToken', refreshToken, refreshCookieOptions);
  res.status(status).json({
    success: true,
    data: { user, accessToken },
  });
}

export const register = asyncHandler(async (req, res) => {
  const result = await authService.registerUser(req.body);
  sendAuthResponse(res, result, 201);
});

export const login = asyncHandler(async (req, res) => {
  const result = await authService.loginUser(req.body);
  sendAuthResponse(res, result);
});

export const googleSchema = z.object({ credential: z.string().min(20, 'Credencial de Google inválida') });

export const googleAuth = asyncHandler(async (req, res) => {
  const result = await authService.googleAuth(req.body.credential);
  sendAuthResponse(res, result);
});

/**
 * GET /api/auth/config — configuración pública para el cliente (Client ID de
 * Google). Sin datos sensibles. Permite ocultar el botón si no está configurado.
 */
export const getAuthConfig = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { googleClientId: env.google.clientId } });
});

export const refresh = asyncHandler(async (req, res) => {
  const token = req.cookies?.refreshToken;
  const tokens = await authService.refreshTokens(token);
  res.cookie('refreshToken', tokens.refreshToken, refreshCookieOptions);
  res.json({ success: true, data: { accessToken: tokens.accessToken } });
});

export const logout = asyncHandler(async (req, res) => {
  res.clearCookie('refreshToken', { path: '/api/auth' });
  res.json({ success: true, message: 'Sesión cerrada' });
});

export const me = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { user: req.user } });
});

export const forgotPassword = asyncHandler(async (req, res) => {
  const result = await authService.requestPasswordReset(req.body.email);
  // En el MVP devolvemos el token para poder probar el flujo sin email real.
  res.json({
    success: true,
    message: 'Si el email existe, se generó un enlace de recuperación (simulado).',
    ...(env.nodeEnv !== 'production' ? { data: { resetToken: result.resetToken } } : {}),
  });
});

export const resetPassword = asyncHandler(async (req, res) => {
  await authService.resetPassword(req.body);
  res.json({ success: true, message: 'Contraseña actualizada, ya puedes iniciar sesión' });
});
