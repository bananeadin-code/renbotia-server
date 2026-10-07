import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { Business } from '../models/Business.js';
import { getPhoneNumberInfo } from '../services/whatsapp.service.js';
import { createLinkCode, ownerControlView, unlinkOwnerNumber } from '../services/ownerControl.service.js';
import { logAudit } from '../services/audit.service.js';

/** GET /api/owner-control — números vinculados y si hay un código vigente. */
export const getOwnerControl = asyncHandler(async (req, res) => {
  const business = await Business.findById(req.businessId).select('ownerWhatsApp ownerLinkCode.expiresAt whatsappPhoneNumberId');
  res.json({
    success: true,
    data: { ...ownerControlView(business), whatsappConnected: Boolean(business?.whatsappPhoneNumberId) },
  });
});

/**
 * POST /api/owner-control/link-code — código de un solo uso (10 min) y el enlace
 * wa.me al número del bot con el código ya escrito.
 */
export const createOwnerLinkCode = asyncHandler(async (req, res) => {
  const business = await Business.findById(req.businessId).select('whatsappPhoneNumberId ownerWhatsApp');
  if (!business?.whatsappPhoneNumberId) {
    throw new ApiError(409, 'Primero conecta el WhatsApp de tu negocio.', { code: 'WHATSAPP_NOT_CONNECTED' });
  }
  if ((business.ownerWhatsApp || []).length >= 2) {
    throw new ApiError(409, 'Ya tienes 2 números vinculados. Quita uno para vincular otro.', { code: 'OWNER_LIMIT' });
  }
  const info = await getPhoneNumberInfo(business.whatsappPhoneNumberId);
  const digits = String(info.displayPhoneNumber || '').replace(/\D/g, '');
  const { code, expiresAt } = await createLinkCode(business._id);
  res.json({
    success: true,
    data: {
      code,
      expiresAt,
      botNumber: info.displayPhoneNumber || '',
      waLink: digits ? `https://wa.me/${digits}?text=${encodeURIComponent(code)}` : '',
    },
  });
});

/** DELETE /api/owner-control/:id — desvincula un número. */
export const unlinkOwner = asyncHandler(async (req, res) => {
  const masked = await unlinkOwnerNumber(req.businessId, String(req.params.id || ''));
  if (!masked) throw ApiError.notFound('Ese número ya no está vinculado.');
  void logAudit({
    businessId: req.businessId,
    userId: req.userId,
    action: 'owner.whatsapp.unlink',
    summary: `Desvinculó el WhatsApp ${masked}.`,
  });
  res.json({ success: true, data: { unlinked: true } });
});
