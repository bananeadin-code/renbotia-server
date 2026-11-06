// Plan anual con cobros REALES en Stripe MODO PRUEBA (tarjetas de prueba, sin
// dinero real): compra, meses sin cargo, cobro del año siguiente, reembolso de
// la garantía, descuento del mes no usado y garantía antes de que inicie el año.
// Se omite si no hay STRIPE_SECRET_KEY de prueba (sk_test_).
import { DAY, setupDb, teardownDb, makeOwner, hasStripeTest, stripeTest } from './helpers.mjs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const skip = !hasStripeTest && 'sin STRIPE_SECRET_KEY de prueba';

describe('plan anual con Stripe (modo prueba)', { skip }, () => {
  let stripe, Subscription, Payment, Session, ensureCustomer, startSession, renewSubscription, pricing, addMonths, srv, A;

  before(async () => {
    await setupDb();
    stripe = await stripeTest();
    ({ Subscription } = await import('../src/models/Subscription.js'));
    ({ Payment } = await import('../src/models/Payment.js'));
    ({ Session } = await import('../src/models/Session.js'));
    ({ ensureCustomer } = await import('../src/services/billingProfile.service.js'));
    ({ startSession } = await import('../src/services/session.service.js'));
    ({ renewSubscription } = await import('../src/services/renewal.service.js'));
    ({ addMonths } = await import('../src/utils/dates.js'));
    pricing = await import('../src/services/pricing.service.js');
    await Promise.all([Payment.init(), Subscription.init()]);
    const { createApp } = await import('../src/app.js');
    srv = createApp().listen(0);
    A = `http://127.0.0.1:${srv.address().port}/api`;
  });
  after(async () => {
    srv?.close();
    await teardownDb();
  });

  async function ownerWithCard(name) {
    const o = await makeOwner(name);
    const { profile, customerId } = await ensureCustomer(o.business._id, o.user._id);
    const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: customerId });
    profile.paymentMethod = { id: pm.id, brand: pm.card.brand, last4: pm.card.last4, expMonth: pm.card.exp_month, expYear: pm.card.exp_year };
    await profile.save();
    const { accessToken } = await startSession({ user: o.user, silent: true, context: { kind: 'owner', business: o.business._id } });
    await Session.updateMany({ user: o.user._id }, { $set: { stepUpAt: new Date() } });
    return { ...o, customerId, token: accessToken };
  }
  const post = async (path, token, body) => {
    const r = await fetch(`${A}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'CF-Connecting-IP': `10.9.${Math.floor(Math.random() * 250)}.1` },
      body: JSON.stringify(body || {}),
    });
    return [r.status, await r.json().catch(() => null)];
  };
  const subOf = (o) => Subscription.findOne({ business: o.business._id }).populate('plan');
  const succeeded = async (customerId) =>
    (await stripe.paymentIntents.list({ customer: customerId, limit: 100 })).data.filter((p) => p.status === 'succeeded');

  it('compra anual: cobra el precio anual exacto y abre un año de 12 meses', async () => {
    const o = await ownerWithCard('AnualReal');
    const expected = pricing.annualPrice('pro');
    const [s, j] = await post('/billing/intent', o.token, { kind: 'plan', planKey: 'pro', cycle: 'anual' });
    assert.equal(s, 200, JSON.stringify(j));
    assert.equal(j.data.status, 'succeeded');
    const pi = await stripe.paymentIntents.retrieve(j.data.paymentIntentId);
    assert.equal(pi.amount, expected * 100, 'Stripe cobró el precio anual exacto');
    assert.equal(pi.metadata.cycle, 'anual');
    const sub = await subOf(o);
    assert.equal(sub.billingCycle, 'anual');
    assert.equal(sub.plan.key, 'pro');
    assert.equal(sub.termEndsAt.getTime(), addMonths(sub.termStartedAt, 12).getTime());
    assert.equal(sub.lockedAnnualMXN, expected);
    assert.equal((await Payment.findOne({ stripeSessionId: pi.id })).cycle, 'anual');

    // Meses dentro del año: reinicia el cupo y NO hay ningún cargo nuevo en Stripe.
    const before = (await succeeded(o.customerId)).length;
    for (let m = 0; m < 3; m++) {
      await Subscription.updateOne({ business: o.business._id }, { $set: { renewalDate: new Date(Date.now() - DAY), tokensUsedThisPeriod: 7777 } });
      assert.equal(await renewSubscription((await subOf(o))._id), 'free');
      const s2 = await subOf(o);
      assert.equal(s2.tokensUsedThisPeriod, 0, 'cupo mensual renovado');
      assert.equal(s2.plan.key, 'pro');
    }
    assert.equal((await succeeded(o.customerId)).length, before, 'ningún cargo dentro del año');

    // Termina el año: un solo cargo por el precio conservado y abre el siguiente año.
    const end = new Date(Date.now() - DAY);
    await Subscription.updateOne({ business: o.business._id }, { $set: { renewalDate: end, termEndsAt: end } });
    const s3 = await subOf(o);
    assert.equal(await renewSubscription(s3._id), 'renewed');
    assert.equal(await renewSubscription(s3._id), 'skipped', 'no cobra dos veces');
    const after = await succeeded(o.customerId);
    assert.equal(after.length, before + 1, 'exactamente un cargo de renovación');
    assert.equal(after[0].amount, expected * 100, 'renovó al precio conservado');
    assert.equal(after[0].metadata.cycle, 'anual');
    const s4 = await subOf(o);
    assert.equal(s4.billingCycle, 'anual');
    assert.ok(s4.termEndsAt > new Date(Date.now() + 360 * DAY), 'nuevo año de 12 meses');
    assert.ok(s4.renewalDate <= addMonths(new Date(), 1), 'el cupo sigue reiniciándose cada mes');
  });

  it('renovación anual con tarjeta rechazada: no regala el año, da gracia y luego pasa a Free', async () => {
    const o = await ownerWithCard('Rechazo');
    const [, j] = await post('/billing/intent', o.token, { kind: 'plan', planKey: 'pro', cycle: 'anual' });
    assert.equal(j.data.status, 'succeeded');
    // Cambia a una tarjeta que el banco rechaza.
    const { BillingProfile } = await import('../src/models/BillingProfile.js');
    const bad = await stripe.paymentMethods.attach('pm_card_chargeCustomerFail', { customer: o.customerId });
    await BillingProfile.updateOne({ business: o.business._id }, { $set: { 'paymentMethod.id': bad.id, 'paymentMethod.last4': bad.card.last4 } });
    const end = new Date(Date.now() - DAY);
    await Subscription.updateOne({ business: o.business._id }, { $set: { renewalDate: end, termEndsAt: end } });
    const before = (await succeeded(o.customerId)).length;
    assert.equal(await renewSubscription((await subOf(o))._id), 'failed');
    let sub = await subOf(o);
    assert.equal(sub.status, 'vencida');
    assert.equal(sub.plan.key, 'pro', 'conserva el plan durante la gracia');
    assert.ok(sub.termEndsAt <= new Date(), 'no abre otro año sin pago');
    // Termina la gracia sin pago: pasa a Free y deja de ser anual.
    await Subscription.updateOne(
      { business: o.business._id },
      { $set: { pastDueSince: new Date(Date.now() - 4 * DAY), nextRenewalAttemptAt: null } }
    );
    assert.equal(await renewSubscription(sub._id), 'failed');
    sub = await subOf(o);
    assert.equal(sub.plan.key, 'free');
    assert.equal(sub.billingCycle, 'mensual');
    assert.equal(sub.founder, false);
    assert.equal((await succeeded(o.customerId)).length, before, 'ningún cargo exitoso');
  });

  it('garantía: reembolso real en Stripe y pasa a Free', async () => {
    const o = await ownerWithCard('GarantiaReal');
    const [, j] = await post('/billing/intent', o.token, { kind: 'plan', planKey: 'elite', cycle: 'anual' });
    assert.equal(j.data.status, 'succeeded');
    const [s, r] = await post('/billing/guarantee-refund', o.token);
    assert.equal(s, 200, JSON.stringify(r));
    const refunds = await stripe.refunds.list({ payment_intent: j.data.paymentIntentId });
    assert.equal(refunds.data.length, 1);
    assert.equal(refunds.data[0].amount, pricing.annualPrice('elite') * 100, 'reembolso completo');
    const sub = await subOf(o);
    assert.equal(sub.plan.key, 'free');
    assert.equal(sub.billingCycle, 'mensual');
    assert.equal((await Payment.findOne({ stripeSessionId: j.data.paymentIntentId })).status, 'refunded');
    assert.equal((await post('/billing/guarantee-refund', o.token))[0], 400, 'una sola vez');
    assert.equal((await stripe.refunds.list({ payment_intent: j.data.paymentIntentId })).data.length, 1, 'sin reembolso doble');
  });

  it('de Pro mensual a Elite anual: descuenta lo que no usó del mes', async () => {
    const o = await ownerWithCard('Cruce');
    const [, m] = await post('/billing/intent', o.token, { kind: 'plan', planKey: 'pro' });
    assert.equal(m.data.status, 'succeeded');
    const [, j] = await post('/billing/intent', o.token, { kind: 'plan', planKey: 'elite', cycle: 'anual' });
    assert.equal(j.data.status, 'succeeded');
    const annual = pricing.annualPrice('elite');
    const charged = (await stripe.paymentIntents.retrieve(j.data.paymentIntentId)).amount / 100;
    assert.ok(charged < annual && charged >= annual - 479, `cobro ${charged} con descuento del mes`);
    const sub = await subOf(o);
    assert.equal(sub.plan.key, 'elite');
    assert.equal(sub.lockedAnnualMXN, annual, 'conserva el precio anual completo para renovar');
  });

  it('de Pro mensual a Pro anual: el año empieza al terminar su mes y la garantía respeta ese mes', async () => {
    const o = await ownerWithCard('MismoPlan');
    const [, m] = await post('/billing/intent', o.token, { kind: 'plan', planKey: 'pro' });
    assert.equal(m.data.status, 'succeeded');
    const monthEnd = (await subOf(o)).renewalDate;
    const [, j] = await post('/billing/intent', o.token, { kind: 'plan', planKey: 'pro', cycle: 'anual' });
    assert.equal(j.data.status, 'succeeded');
    const sub = await subOf(o);
    assert.equal(sub.termStartedAt.getTime(), monthEnd.getTime());
    assert.equal(sub.renewalDate.getTime(), monthEnd.getTime(), 'su mes pagado sigue igual');

    const [s] = await post('/billing/guarantee-refund', o.token);
    assert.equal(s, 200);
    const after = await subOf(o);
    assert.equal(after.plan.key, 'pro', 'conserva el mes que pagó');
    assert.equal(after.status, 'cancelada', 'y pasa a Free al terminarlo');
    assert.equal(after.billingCycle, 'mensual');
    // Al llegar el fin de su mes: Free, sin cobro.
    await Subscription.updateOne({ business: o.business._id }, { $set: { renewalDate: new Date(Date.now() - DAY) } });
    const before = (await succeeded(o.customerId)).length;
    assert.equal(await renewSubscription(after._id), 'free');
    assert.equal((await subOf(o)).plan.key, 'free');
    assert.equal((await succeeded(o.customerId)).length, before, 'sin cargos');
  });
});
