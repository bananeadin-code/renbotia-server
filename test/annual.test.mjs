// Plan anual: cotización, compra, meses sin cobro dentro del año, cobro al
// terminar, cancelación, mejora proporcional, garantía de 30 días y vista de la
// agencia (sin datos personales). Sin llamar a Stripe.
import { DAY, setupDb, teardownDb, makeOwner } from './helpers.mjs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

describe('plan anual y vista de agencia', () => {
  let srv, A, Subscription, Plan, Payment, Session, User, startSession, fulfill, renewal, pricing, stripeSvc, addMonths;

  before(async () => {
    await setupDb();
    ({ Subscription } = await import('../src/models/Subscription.js'));
    ({ Plan } = await import('../src/models/Plan.js'));
    ({ Payment } = await import('../src/models/Payment.js'));
    ({ Session } = await import('../src/models/Session.js'));
    ({ User } = await import('../src/models/User.js'));
    ({ startSession } = await import('../src/services/session.service.js'));
    ({ addMonths } = await import('../src/utils/dates.js'));
    fulfill = await import('../src/services/fulfillment.service.js');
    renewal = await import('../src/services/renewal.service.js');
    pricing = await import('../src/services/pricing.service.js');
    stripeSvc = await import('../src/services/stripe.service.js');
    // Índices únicos listos antes de probar la idempotencia (en producción ya existen).
    await Promise.all([Payment.init(), Subscription.init()]);
    const { createApp } = await import('../src/app.js');
    srv = createApp().listen(0);
    A = `http://127.0.0.1:${srv.address().port}/api`;
  });
  after(async () => {
    stripeSvc.__setRefundHook(null);
    srv?.close();
    await teardownDb();
  });

  let piSeq = 0;
  const fakePi = (o, metadata, amountMXN) => ({
    id: `pi_test_anual_${Date.now()}_${++piSeq}`,
    status: 'succeeded',
    amount: Math.round(amountMXN * 100),
    created: Math.floor(Date.now() / 1000),
    metadata: { type: 'plan', userId: String(o.user._id), businessId: String(o.business._id), ...metadata },
  });
  const subOf = (o) => Subscription.findOne({ business: o.business._id }).populate('plan');
  const tokenFor = async (o, role) => {
    if (role) await User.updateOne({ _id: o.user._id }, { $set: { role } });
    const user = await User.findById(o.user._id);
    const { accessToken } = await startSession({ user, silent: true, context: { kind: 'owner', business: o.business._id } });
    await Session.updateMany({ user: o.user._id }, { $set: { stepUpAt: new Date() } });
    return accessToken;
  };
  const call = async (method, path, token, body) => {
    const r = await fetch(`${A}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'CF-Connecting-IP': `10.7.${Math.floor(Math.random() * 250)}.1`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* CSV */
    }
    return [r.status, json, text];
  };
  async function buyAnnual(o, planKey = 'pro') {
    const s = await subOf(o);
    const q = pricing.quotePlanPurchase(s, planKey, 'anual');
    assert.ok(!q.error, q.error);
    const pi = fakePi(o, { planKey, ...q.meta }, q.amountMXN);
    const r = await fulfill.fulfillPaymentIntent(pi);
    assert.equal(r.applied, true);
    return { pi, amountMXN: q.amountMXN };
  }

  it('cotiza: mensual, anual (fundador o normal) y bloquea casos inválidos', async () => {
    const now = new Date('2026-11-10T18:00:00Z');
    const free = { plan: { key: 'free' }, renewalDate: new Date(now.getTime() + 20 * DAY), status: 'activa' };
    assert.equal(pricing.quotePlanPurchase(free, 'pro', 'mensual', now).amountMXN, 479);
    assert.equal(pricing.quotePlanPurchase(free, 'pro', 'anual', now).amountMXN, 4311);
    assert.equal(pricing.quotePlanPurchase(free, 'elite', 'anual', now).amountMXN, 8991);
    assert.equal(pricing.quotePlanPurchase(free, 'pro', 'anual', new Date('2027-02-02T18:00:00Z')).amountMXN, 4790);

    // Pro mensual vigente → Pro anual: el año arranca al terminar el mes pagado.
    const proMonthly = { ...free, plan: { key: 'pro' } };
    const q = pricing.quotePlanPurchase(proMonthly, 'pro', 'anual', now);
    assert.equal(q.meta.annualStart, String(proMonthly.renewalDate.getTime()));

    // Con año vigente: no se compra mensual ni el mismo plan; Elite paga proporcional.
    const proAnnual = {
      plan: { key: 'pro' },
      founder: true, // compró en noviembre: conserva "9 de 12" también al mejorar en mayo
      billingCycle: 'anual',
      termStartedAt: now,
      termEndsAt: addMonths(now, 12),
      termPaidMXN: 4311,
      renewalDate: addMonths(now, 1),
    };
    assert.ok(pricing.quotePlanPurchase(proAnnual, 'elite', 'mensual', now).error);
    assert.ok(pricing.quotePlanPurchase(proAnnual, 'pro', 'anual', now).error);
    const half = new Date(now.getTime() + (addMonths(now, 12) - now) / 2);
    const up = pricing.quotePlanPurchase(proAnnual, 'elite', 'anual', half);
    assert.equal(up.meta.mode, 'annual_upgrade');
    assert.ok(Math.abs(up.amountMXN - (8991 - 4311) / 2) <= 2, `prorrateo ${up.amountMXN}`);
    // Sin precio de fundador, en mayo ya rige el anual normal de Elite ($9,990).
    const up2 = pricing.quotePlanPurchase({ ...proAnnual, founder: false }, 'elite', 'anual', half);
    assert.ok(Math.abs(up2.amountMXN - (9990 - 4311) / 2) <= 2, `prorrateo normal ${up2.amountMXN}`);
  });

  it('compra anual: año de 12 meses, garantía, fundador y pago registrado como anual', async () => {
    const o = await makeOwner('Anual');
    const { pi, amountMXN } = await buyAnnual(o, 'pro');
    const s = await subOf(o);
    assert.equal(s.plan.key, 'pro');
    assert.equal(s.billingCycle, 'anual');
    assert.equal(s.termEndsAt.getTime(), addMonths(s.termStartedAt, 12).getTime());
    assert.equal(s.lockedAnnualMXN, amountMXN);
    assert.equal(s.founder, pricing.isFounderWindow(new Date()));
    assert.ok(s.guaranteeEndsAt > new Date(Date.now() + 29 * DAY));
    assert.deepEqual([...s.guaranteePaymentIds], [pi.id]);
    const pay = await Payment.findOne({ stripeSessionId: pi.id });
    assert.equal(pay.cycle, 'anual');
    assert.equal(pay.description, 'Plan Pro anual');
    // Repetir la entrega no duplica nada.
    assert.equal((await fulfill.fulfillPaymentIntent(pi)).alreadyProcessed, true);
  });

  it('dentro del año: cada mes reinicia el cupo SIN cobrar, aunque haya cancelado', async () => {
    const o = await makeOwner('Mes');
    await buyAnnual(o, 'pro');
    await Subscription.updateOne(
      { business: o.business._id },
      { $set: { renewalDate: new Date(Date.now() - DAY), tokensUsedThisPeriod: 5000, status: 'cancelada' } }
    );
    const before = await Payment.countDocuments({ business: o.business._id });
    const s0 = await subOf(o);
    assert.equal(await renewal.renewSubscription(s0._id), 'free');
    const s = await subOf(o);
    assert.equal(s.plan.key, 'pro', 'conserva el plan');
    assert.equal(s.status, 'cancelada', 'respeta la cancelación hasta fin de año');
    assert.equal(s.tokensUsedThisPeriod, 0, 'cupo nuevo');
    assert.ok(s.renewalDate > new Date());
    assert.ok(s.renewalDate <= s.termEndsAt);
    assert.equal(await Payment.countDocuments({ business: o.business._id }), before, 'sin cobro');
  });

  it('al terminar el año: cobra el año siguiente al precio conservado; si canceló, pasa a Free', async () => {
    const o = await makeOwner('Fin');
    const { amountMXN } = await buyAnnual(o, 'pro');
    const end = new Date(Date.now() - DAY);
    await Subscription.updateOne({ business: o.business._id }, { $set: { renewalDate: end, termEndsAt: end } });
    const token = await tokenFor(o);
    const [st, js] = await call('GET', '/subscription/me', token);
    assert.equal(st, 200);
    assert.equal(js.data.subscription.renewalAmountMXN, amountMXN, 'precio conservado');
    assert.equal(js.data.subscription.nextChargeCycle, 'anual');
    // Sin tarjeta: intenta cobrar y queda vencida (no regala otro año).
    const s0 = await subOf(o);
    assert.equal(await renewal.renewSubscription(s0._id), 'failed');
    assert.equal((await subOf(o)).status, 'vencida');

    const c = await makeOwner('Cancela');
    await buyAnnual(c, 'pro');
    await Subscription.updateOne({ business: c.business._id }, { $set: { renewalDate: end, termEndsAt: end, status: 'cancelada' } });
    const c0 = await subOf(c);
    assert.equal(await renewal.renewSubscription(c0._id), 'free');
    const cs = await subOf(c);
    assert.equal(cs.plan.key, 'free');
    assert.equal(cs.billingCycle, 'mensual');
    assert.equal(cs.founder, false);
    assert.equal(cs.termEndsAt, null);
  });

  it('mejora a mitad del año: cambia el plan al instante y el año no se mueve', async () => {
    const o = await makeOwner('Mejora');
    const { pi: first } = await buyAnnual(o, 'pro');
    const s0 = await subOf(o);
    const q = pricing.quotePlanPurchase(s0, 'elite', 'anual');
    assert.equal(q.meta.mode, 'annual_upgrade');
    const pi = fakePi(o, { planKey: 'elite', ...q.meta }, q.amountMXN);
    assert.equal((await fulfill.fulfillPaymentIntent(pi)).applied, true);
    const s = await subOf(o);
    assert.equal(s.plan.key, 'elite');
    assert.equal(s.termEndsAt.getTime(), s0.termEndsAt.getTime());
    assert.equal(s.lockedPlanKey, 'elite');
    assert.deepEqual([...s.guaranteePaymentIds], [first.id, pi.id], 'la garantía cubre también la mejora');
  });

  it('garantía de 30 días: reembolsa todo, pasa a Free y no se puede usar dos veces', async () => {
    const o = await makeOwner('Garantia');
    const { pi, amountMXN } = await buyAnnual(o, 'pro');
    const refunds = [];
    stripeSvc.__setRefundHook(async (r) => {
      refunds.push(r);
      return { id: `re_${r.paymentIntentId}`, status: 'succeeded', amount: amountMXN * 100 };
    });
    const token = await tokenFor(o);
    const [s1, j1] = await call('POST', '/billing/guarantee-refund', token);
    assert.equal(s1, 200, JSON.stringify(j1));
    assert.equal(j1.data.refundedMXN, amountMXN);
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].idempotencyKey, `guarantee_${pi.id}`);
    const pay = await Payment.findOne({ stripeSessionId: pi.id });
    assert.equal(pay.status, 'refunded');
    const s = await subOf(o);
    assert.equal(s.plan.key, 'free');
    assert.equal(s.billingCycle, 'mensual');
    assert.equal(s.annualGuaranteeGranted, true);
    const [s2] = await call('POST', '/billing/guarantee-refund', token);
    assert.equal(s2, 400, 'solo una vez');

    // Una segunda compra anual ya no trae garantía.
    await buyAnnual(o, 'pro');
    assert.equal((await subOf(o)).guaranteeEndsAt, null);
  });

  it('agencia: ve campañas sin datos personales, captura pauta y descarga conversiones de Google', async () => {
    // Un registro que llegó por Google Ads, con consentimiento, y pagó.
    const lead = await makeOwner('Pauta');
    await User.updateOne(
      { _id: lead.user._id },
      { $set: { acquisition: { source: 'google', medium: 'cpc', campaign: 'registro-esteticas', content: 'video-1', gclid: 'GCLID-TEST-1', adsConsent: true } } }
    );
    const { pi } = await buyAnnual(lead, 'pro');

    const ag = await makeOwner('Agencia');
    const TA = await tokenFor(ag, 'agencia');
    const [sc, jc, raw] = await call('GET', '/funnel/campaigns', TA);
    assert.equal(sc, 200);
    const g = jc.data.report.campaigns.find((c) => c.campaign === 'registro-esteticas');
    assert.ok(g && g.pago === 1 && g.annual === 1, 'cuenta el pago anual de la campaña');
    assert.ok(!raw.includes(lead.user.email), 'no expone correos');
    assert.ok(!raw.includes('Negocio Pauta'), 'no expone nombres de negocio');

    assert.equal((await call('GET', '/funnel/leads', TA))[0], 403, 'no ve el CRM');
    assert.equal((await call('GET', '/funnel/summary', TA))[0], 403, 'no ve el resumen con todos los ingresos');
    assert.equal((await call('PUT', '/funnel/campaign-spend', TA, { month: '2026-11', channel: 'agencia', amountMXN: 1 }))[0], 400);
    assert.equal((await call('PUT', '/funnel/campaign-spend', TA, { month: '2026-11', channel: 'google', amountMXN: 2500 }))[0], 200);

    const [sv, , csv] = await call('GET', '/funnel/offline-conversions.csv', TA);
    assert.equal(sv, 200);
    assert.match(csv, /^Parameters:TimeZone=America\/Mexico_City/);
    assert.ok(csv.includes(`GCLID-TEST-1,Compra,`), csv);
    assert.ok(csv.includes(`,MXN,${pi.id}`), 'Order ID = transaction_id del sitio');

    // Soporte no entra a campañas.
    const sp = await makeOwner('Soporte');
    assert.equal((await call('GET', '/funnel/campaigns', await tokenFor(sp, 'soporte')))[0], 403);
  });
});
