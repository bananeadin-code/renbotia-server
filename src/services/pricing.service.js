import { PLANS, ANNUAL, ORIENTATION } from '../config/constants.js';
import { env } from '../config/env.js';

/**
 * Precios por ciclo (mensual / anual), precio de fundador, prorrateo de mejoras a
 * mitad del año y reglas del periodo anual. Sin acceso a la base: funciones puras
 * que usan el cobrador, el checkout y las pantallas.
 */

const DAY = 864e5;
const at = (d) => (d ? new Date(d).getTime() : NaN);

export const CYCLES = ['mensual', 'anual'];

export const planOf = (key) => PLANS.find((p) => p.key === key);
export const monthlyPrice = (key) => planOf(key)?.priceMXN ?? 0;

export const founderUntil = () => new Date(process.env.FOUNDER_UNTIL || ANNUAL.founderUntil);
export const isFounderWindow = (now = new Date()) => at(now) < founderUntil().getTime();
export const annualMonthsPaid = (now = new Date()) =>
  isFounderWindow(now) ? ANNUAL.founderMonthsPaid : ANNUAL.standardMonthsPaid;

/** Precio anual de lista hoy (fundador o normal). 0 para Free. */
export function annualPrice(key, now = new Date()) {
  const m = monthlyPrice(key);
  return m ? m * annualMonthsPaid(now) : 0;
}

/**
 * Precio anual que le toca a ESTA suscripción para un plan: el de lista, pero un
 * fundador nunca paga más que "9 de 12" y quien renueva el mismo plan conserva
 * el precio con el que lo contrató (si la lista sube, no le sube a él).
 */
export function annualPriceFor(sub, key, now = new Date()) {
  let p = annualPrice(key, now);
  if (!p) return 0;
  if (sub?.founder) p = Math.min(p, monthlyPrice(key) * ANNUAL.founderMonthsPaid);
  if (sub?.lockedPlanKey === key && sub?.lockedAnnualMXN > 0) p = Math.min(p, sub.lockedAnnualMXN);
  return p;
}

/** Monto del cobro de renovación según el ciclo del siguiente periodo. */
export function renewalPrice(sub, key, cycle, now = new Date()) {
  return cycle === 'anual' ? annualPriceFor(sub, key, now) : monthlyPrice(key);
}

/**
 * ¿El periodo que termina en `boundary` (por defecto la renovación mensual de
 * créditos) cae DENTRO del año ya pagado? Entonces esa renovación no se cobra:
 * solo reinicia el cupo del mes.
 */
export function insidePaidTerm(sub, boundary = sub?.renewalDate) {
  if (sub?.billingCycle !== 'anual' || !sub?.termEndsAt || !boundary) return false;
  return at(boundary) < at(sub.termEndsAt);
}

/** ¿Tiene un año pagado vigente HOY? */
export const hasActiveAnnual = (sub, now = new Date()) =>
  sub?.billingCycle === 'anual' && Boolean(sub?.termEndsAt) && at(sub.termEndsAt) > at(now);

/** Ciclo con el que arranca el siguiente periodo de cobro. */
export function nextCycle(sub) {
  if (insidePaidTerm(sub)) return 'anual';
  return sub?.pendingCycle || sub?.billingCycle || 'mensual';
}

/** Fecha y monto del próximo cobro real (en anual, al terminar el año). */
export function nextChargeDate(sub) {
  return insidePaidTerm(sub) ? sub.termEndsAt : sub?.renewalDate;
}

/**
 * Mejora de plan a mitad del año (p. ej. Pro anual → Elite anual): se cobra solo
 * la diferencia proporcional al tiempo que falta. El año no cambia de fecha.
 * @returns {{ amountMXN: number, newAnnualMXN: number, fraction: number }}
 */
export function prorateAnnualUpgrade(sub, newKey, now = new Date()) {
  const newAnnualMXN = annualPriceFor({ ...sub, lockedPlanKey: '' }, newKey, now);
  const start = at(sub.termStartedAt) || at(sub.termEndsAt) - 365 * DAY;
  const end = at(sub.termEndsAt);
  const total = Math.max(DAY, end - start);
  const fraction = Math.min(1, Math.max(0, (end - at(now)) / total));
  const paid = sub.termPaidMXN || annualPriceFor(sub, sub.plan?.key, now);
  const diff = Math.max(0, newAnnualMXN - paid);
  // Stripe no acepta cargos menores a $10 MXN.
  const amountMXN = Math.max(10, Math.round(diff * fraction));
  return { amountMXN, newAnnualMXN, fraction };
}

/**
 * Cotiza la compra de un plan desde el checkout. Decide el caso y el monto:
 *  - mensual: solo mejoras sin año vigente (precio de lista).
 *  - anual con año vigente: mejora a mitad del año (diferencia proporcional).
 *  - anual nuevo: precio anual; si ya paga ese mismo plan mensual y su mes sigue
 *    vigente, el año arranca al terminar ese mes (annualStart).
 * @returns {{ amountMXN:number, description:string, meta:object } | { error:string }}
 */
export function quotePlanPurchase(sub, planKey, cycle = 'mensual', now = new Date()) {
  const plan = planOf(planKey);
  if (!plan || !plan.priceMXN) return { error: 'Plan inválido' };
  const currentKey = sub?.plan?.key;
  const currentPrice = monthlyPrice(currentKey);
  const annualActive = hasActiveAnnual(sub, now);

  if (cycle !== 'anual') {
    if (annualActive) {
      return { error: 'Tienes un plan anual vigente. Para pasar a mensual, prográmalo para cuando termine tu año.' };
    }
    if (plan.priceMXN <= currentPrice) {
      return { error: 'Para bajar o mantener tu plan usa "Cambiar plan"; aplica en tu renovación.' };
    }
    return { amountMXN: plan.priceMXN, description: `Plan ${plan.name} — RenBotIA`, meta: { cycle: 'mensual', mode: 'monthly' } };
  }

  if (annualActive) {
    if (plan.priceMXN <= currentPrice) {
      return { error: 'Ya tienes este plan anual o uno mayor. Para bajar de plan, prográmalo para el final de tu año.' };
    }
    const p = prorateAnnualUpgrade(sub, plan.key, now);
    return {
      amountMXN: p.amountMXN,
      description: `Mejora a Plan ${plan.name} anual (proporcional) — RenBotIA`,
      meta: {
        cycle: 'anual',
        mode: 'annual_upgrade',
        newAnnualMXN: String(p.newAnnualMXN),
        termEndsAt: String(at(sub.termEndsAt)),
      },
    };
  }

  const keepPaidMonth =
    currentKey === plan.key &&
    currentPrice > 0 &&
    !sub?.complimentary &&
    sub?.status !== 'vencida' &&
    at(sub?.renewalDate) > at(now);
  return {
    amountMXN: annualPriceFor(sub, plan.key, now),
    description: `Plan ${plan.name} anual — RenBotIA`,
    meta: { cycle: 'anual', mode: 'annual', annualStart: keepPaidMonth ? String(at(sub.renewalDate)) : '0' },
  };
}

/** ¿La garantía de 30 días sigue vigente? */
export const guaranteeActive = (sub, now = new Date()) =>
  Boolean(sub?.guaranteeEndsAt) && at(sub.guaranteeEndsAt) > at(now) && (sub.guaranteePaymentIds?.length || 0) > 0;

export const guaranteeEndsFrom = (now = new Date()) => new Date(at(now) + ANNUAL.guaranteeDays * DAY);

/** Sesión de orientación gratuita: todos durante el lanzamiento; siempre en anual. */
export const orientationFreeUntil = () => new Date(process.env.ORIENTATION_FREE_UNTIL || ORIENTATION.freeUntil);
export const orientationIncluded = (sub, now = new Date()) =>
  at(now) < orientationFreeUntil().getTime() || hasActiveAnnual(sub, now);

/** Lo que necesitan las pantallas para mostrar el anual (público). */
export function pricingConfig(now = new Date()) {
  return {
    annual: {
      founder: isFounderWindow(now),
      founderUntil: founderUntil(),
      monthsPaid: annualMonthsPaid(now),
      founderMonthsPaid: ANNUAL.founderMonthsPaid,
      standardMonthsPaid: ANNUAL.standardMonthsPaid,
      guaranteeDays: ANNUAL.guaranteeDays,
    },
    orientation: {
      freeForAll: at(now) < orientationFreeUntil().getTime(),
      freeUntil: orientationFreeUntil(),
      bookingUrl: env.funnel?.bookingUrl || '',
    },
  };
}

/** Precios anuales de un plan para la lista pública. */
export function annualInfo(key, now = new Date()) {
  const monthly = monthlyPrice(key);
  if (!monthly) return null;
  const priceMXN = annualPrice(key, now);
  return {
    priceMXN,
    monthsPaid: annualMonthsPaid(now),
    perMonthMXN: Math.round(priceMXN / 12),
    savingsMXN: monthly * 12 - priceMXN,
    standardPriceMXN: monthly * ANNUAL.standardMonthsPaid,
  };
}

const fmtMoney = (n) => `$${Number(n).toLocaleString('es-MX')}`;
const fmtLongDate = (d) =>
  new Date(d).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' });

/**
 * Texto del plan anual para el asistente del sitio (se arma al momento, así
 * cambia solo de "fundador" a precio normal cuando pasa la fecha).
 */
export function annualPricingText(now = new Date()) {
  const pro = annualInfo('pro', now);
  const elite = annualInfo('elite', now);
  if (!pro || !elite) return '';
  const founder = isFounderWindow(now);
  const lastFounderDay = new Date(founderUntil().getTime() - 1);
  const orientation =
    at(now) < orientationFreeUntil().getTime()
      ? 'Sesión de orientación por videollamada gratis para todos durante el lanzamiento (siempre incluida en el plan anual).'
      : 'El plan anual incluye una sesión de orientación por videollamada.';
  return [
    `Plan anual: pagas ${annualMonthsPaid(now)} meses y recibes 12. Pro ${fmtMoney(pro.priceMXN)} MXN al año (equivale a ${fmtMoney(
      pro.perMonthMXN
    )} al mes) y Elite ${fmtMoney(elite.priceMXN)} MXN al año (equivale a ${fmtMoney(elite.perMonthMXN)} al mes)${
      founder ? `; es precio de fundador, válido hasta el ${fmtLongDate(lastFounderDay)}, y se conserva mientras renueves en anual` : ''
    }.`,
    'El plan anual tiene garantía de 30 días con reembolso completo.',
    orientation,
  ].join(' ');
}
