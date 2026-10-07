import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { receiptEmail } from '../emails/receipt.js';
import { lowBalanceEmail } from '../emails/lowBalance.js';
import { passwordResetEmail } from '../emails/passwordReset.js';
import { welcomeEmail } from '../emails/welcome.js';
import { escalationEmail } from '../emails/escalation.js';
import { hotLeadEmail } from '../emails/hotLead.js';
import { contactEmail } from '../emails/contact.js';
import { weeklyReportEmail } from '../emails/weeklyReport.js';
import { referralRewardEmail } from '../emails/referralReward.js';
import { renewalEmail } from '../emails/renewal.js';
import { User } from '../models/User.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Envía un correo vía la API de Resend usando fetch (sin dependencia extra).
 * Es FAIL-OPEN: si no hay API key o Resend falla, registra el problema y
 * devuelve un resultado sin lanzar, para no romper el flujo de compra.
 *
 * @param {{ to: string, subject: string, html: string }} msg
 * @returns {Promise<{ ok?: boolean, skipped?: boolean, id?: string, status?: number, error?: string }>}
 */
export async function sendEmail({ to, subject, html, replyTo, attachments }) {
  if (!env.resend.apiKey) {
    logger.warn('[email] RESEND_API_KEY no configurada; se omite el envío.');
    return { skipped: true };
  }
  if (!to) {
    logger.warn('[email] Sin destinatario; se omite el envío.');
    return { skipped: true };
  }

  // reply_to: el que se pase explícito (p. ej. el correo de quien escribe en el
  // formulario de contacto) tiene prioridad sobre el global de env.
  const replyToAddr = replyTo || env.resend.replyTo;

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.resend.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.resend.from,
        to: [to],
        subject,
        html,
        ...(replyToAddr ? { reply_to: replyToAddr } : {}),
        // Adjuntos opcionales: [{ filename, content (base64) }] (p. ej. respaldos).
        ...(attachments?.length ? { attachments } : {}),
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn(`[email] Resend respondió ${res.status}: ${text.slice(0, 300)}`);
      return { ok: false, status: res.status };
    }
    const data = await res.json().catch(() => ({}));
    logger.info(`[email] Enviado a ${to} (id ${data.id || '—'})`);
    return { ok: true, id: data.id };
  } catch (err) {
    logger.warn(`[email] Error enviando a ${to}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Envía un mensaje del formulario de contacto público a tu buzón (env.contactInbox),
 * vía Resend (saliente, no depende del reenvío entrante del dominio). El reply_to
 * es el correo de quien escribe, para responderle directo. Fail-open.
 * @param {{ name:string, email:string, topic?:string, message:string }} p
 */
export async function sendContactEmail(p) {
  const to = env.contactInbox || env.resend.replyTo;
  if (!to) {
    logger.warn('[email] CONTACT_INBOX no configurado; no hay a dónde enviar el contacto.');
    return { skipped: true };
  }
  const { subject, html } = contactEmail(p);
  return sendEmail({ to, subject, html, replyTo: p.email });
}

/**
 * Envía el comprobante de una compra al correo registrado del usuario.
 * Resuelve el email/nombre del usuario si solo se pasa el userId. Fail-open.
 *
 * @param {object} p
 * @param {string|import('mongoose').Types.ObjectId} [p.userId]
 * @param {string} [p.to]           Correo directo (si ya se tiene).
 * @param {string} [p.customerName]
 * @param {string} [p.businessName]
 * @param {'plan'|'credits'} p.type
 * @param {string} p.description
 * @param {number} p.amountMXN
 * @param {number} [p.tokens]
 * @param {string} [p.reference]
 * @param {boolean}[p.auto]
 * @param {number} [p.availableAfter]
 */
export async function sendPurchaseReceipt(p) {
  try {
    let to = p.to;
    let customerName = p.customerName;
    if ((!to || !customerName) && p.userId) {
      const user = await User.findById(p.userId).select('email name').lean();
      to = to || user?.email;
      customerName = customerName || user?.name;
    }
    if (!to) {
      logger.warn('[email] No se encontró correo del usuario para el comprobante.');
      return { skipped: true };
    }
    const { subject, html } = receiptEmail({ ...p, customerName });
    return await sendEmail({ to, subject, html });
  } catch (err) {
    logger.warn(`[email] No se pudo enviar el comprobante: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Envía el correo de bienvenida al activar la cuenta. Fail-open.
 * @param {{ to: string, customerName?: string }} p
 */
export async function sendWelcomeEmail(p) {
  try {
    if (!p.to) return { skipped: true };
    const { subject, html } = welcomeEmail(p);
    return await sendEmail({ to: p.to, subject, html });
  } catch (err) {
    logger.warn(`[email] No se pudo enviar la bienvenida: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Envía el correo para restablecer la contraseña. Fail-open.
 * @param {{ to: string, customerName?: string, link: string, minutes?: number }} p
 */
export async function sendPasswordResetEmail(p) {
  try {
    if (!p.to) return { skipped: true };
    const { subject, html } = passwordResetEmail(p);
    return await sendEmail({ to: p.to, subject, html });
  } catch (err) {
    logger.warn(`[email] No se pudo enviar el correo de reset: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Avisa al dueño que una conversación necesita atención humana (el bot escaló).
 * Fail-open. Resuelve el correo del usuario por userId si no se pasa `to`.
 * @param {object} p
 * @param {string|import('mongoose').Types.ObjectId} [p.userId]
 * @param {string} [p.to]
 * @param {string} [p.businessName]
 * @param {string} [p.reason]
 * @param {string} [p.contactName]
 * @param {string} [p.preview]
 */
export async function sendEscalationEmail(p) {
  try {
    const user = p.userId ? await User.findById(p.userId).select('email name').lean() : null;
    const to = p.to || user?.email;
    if (!to) return { skipped: true };
    const { subject, html } = escalationEmail({ ...p, customerName: user?.name });
    return await sendEmail({ to, subject, html });
  } catch (err) {
    logger.warn(`[email] No se pudo enviar el aviso de escalación: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Envía el aviso de "lead caliente" al correo del dueño: el bot detectó alta
 * intención de compra en una conversación. Fail-open.
 * @param {object} p
 * @param {string|import('mongoose').Types.ObjectId} p.userId
 * @param {string} [p.businessName]
 * @param {string} [p.reason]
 * @param {string} [p.contactName]
 * @param {string} [p.preview]
 */
export async function sendHotLeadEmail(p) {
  try {
    const user = p.userId ? await User.findById(p.userId).select('email name').lean() : null;
    const to = p.to || user?.email;
    if (!to) return { skipped: true };
    const { subject, html } = hotLeadEmail({ ...p, customerName: user?.name });
    return await sendEmail({ to, subject, html });
  } catch (err) {
    logger.warn(`[email] No se pudo enviar el aviso de lead caliente: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Envía el aviso de "crédito bajo" al correo del usuario. Fail-open.
 * @param {object} p
 * @param {string|import('mongoose').Types.ObjectId} p.userId
 * @param {string} [p.businessName]
 * @param {number} p.available
 * @param {string} [p.planName]
 */
export async function sendLowBalanceEmail(p) {
  try {
    const user = p.userId ? await User.findById(p.userId).select('email name').lean() : null;
    const to = p.to || user?.email;
    if (!to) return { skipped: true };
    const { subject, html } = lowBalanceEmail({ ...p, customerName: user?.name });
    return await sendEmail({ to, subject, html });
  } catch (err) {
    logger.warn(`[email] No se pudo enviar el aviso de crédito bajo: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Reporte semanal del lunes al dueño (resultados, leads y pendientes). Fail-open.
 * @param {{ userId:any, businessName?:string, impact:object, leads:Array, learning:Array, learningTotal:number }} p
 */
export async function sendWeeklyReportEmail(p) {
  try {
    const user = p.userId ? await User.findById(p.userId).select('email name').lean() : null;
    const to = p.to || user?.email;
    if (!to) return { skipped: true };
    const { subject, html } = weeklyReportEmail({ ...p, customerName: user?.name });
    return await sendEmail({ to, subject, html });
  } catch (err) {
    logger.warn(`[email] No se pudo enviar el reporte semanal: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/** Aviso de recompensa por referidos. Fail-open. */
export async function sendReferralRewardEmail(p) {
  try {
    if (!p.to) return { skipped: true };
    const { subject, html } = referralRewardEmail(p);
    return await sendEmail({ to: p.to, subject, html });
  } catch (err) {
    logger.warn(`[email] No se pudo enviar el aviso de referidos: ${err.message}`);
    return { ok: false, error: err.message };
  }
}


/**
 * Avisos de renovación del plan (próximo cobro, cobro fallido, baja a Free).
 * Fail-open: un correo que no sale nunca rompe el cobrador.
 * @param {object} p  ver emails/renewal.js (+ userId para resolver el correo)
 */
export async function sendRenewalNoticeEmail(p) {
  try {
    const user = p.userId ? await User.findById(p.userId).select('email name').lean() : null;
    const to = p.to || user?.email;
    if (!to) return { skipped: true };
    const { subject, html } = renewalEmail({ ...p, customerName: user?.name });
    return await sendEmail({ to, subject, html });
  } catch (err) {
    logger.warn(`[email] No se pudo enviar el aviso de renovación: ${err.message}`);
    return { ok: false, error: err.message };
  }
}
