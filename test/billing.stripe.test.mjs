// Cobros reales en Stripe MODO PRUEBA: renovación, idempotencia, tarjeta primero.
// Se omite si no hay STRIPE_SECRET_KEY de prueba (sk_test_).
import { DAY, setupDb, teardownDb, makeOwner, hasStripeTest, stripeTest } from './helpers.mjs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const skip = !hasStripeTest && 'sin STRIPE_SECRET_KEY de prueba';

describe('cobros con Stripe (modo prueba)', { skip }, () => {
  let stripe, Subscription, Plan, Payment, ensureCustomer, renewSubscription, renewalKeyFor, chargeOffSession, createApp;
  let srv, A;

  before(async () => {
    await setupDb();
    stripe = await stripeTest();
    ({ Subscription } = await import('../src/models/Subscription.js'));
    ({ Plan } = await import('../src/models/Plan.js'));
    ({ Payment } = await import('../src/models/Payment.js'));
    ({ ensureCustomer } = await import('../src/services/billingProfile.service.js'));
    ({ renewSubscription, renewalKeyFor } = await import('../src/services/renewal.service.js'));
    ({ chargeOffSession } = await import('../src/services/stripe.service.js'));
    ({ createApp } = await import('../src/app.js'));
    srv = createApp().listen(0);
    A = `http://127.0.0.1:${srv.address().port}/api`;
  });
  after(async () => {
    srv?.close();
    await teardownDb();
  });

  const sub = (b) => Subscription.findOne({ business: b._id }).populate('plan');
  async function duePlan(b, key = 'pro', set = {}) {
    const plan = await Plan.findOne({ key });
    await Subscription.updateOne(
      { business: b._id },
      { $set: { plan: plan._id, renewalDate: new Date(Date.now() - DAY), tokensUsedThisPeriod: 1000, ...set } }
    );
  }
  async function addCard(b, u, pmToken) {
    const { profile, customerId } = await ensureCustomer(b._id, u._id);
    const pm = await stripe.paymentMethods.attach(pmToken, { customer: customerId });
    profile.paymentMethod = { id: pm.id, brand: pm.card.brand, last4: pm.card.last4, expMonth: pm.card.exp_month, expYear: pm.card.exp_year };
    await profile.save();
    return { customerId, pmId: pm.id };
  }
  const charges = async (customerId, key) =>
    (await stripe.paymentIntents.list({ customer: customerId, limit: 50 })).data.filter(
      (p) => p.status === 'succeeded' && (!key || p.metadata.renewalKey === key)
    );

  it('renueva cobrando la tarjeta guardada (un solo cargo, periodo nuevo)', async () => {
    const { user, business } = await makeOwner('Ana');
    await duePlan(business);
    const { customerId } = await addCard(business, user, 'pm_card_visa');
    const s0 = await sub(business);
    assert.equal(await renewSubscription(s0._id), 'renewed');
    const s = await sub(business);
    assert.equal(s.status, 'activa');
    assert.equal(s.tokensUsedThisPeriod, 0);
    assert.ok(s.renewalDate > s0.renewalDate);
    assert.equal((await charges(customerId)).length, 1);
    assert.equal(await Payment.countDocuments({ business: business._id, renewal: true }), 1);
    assert.equal(await renewSubscription(s._id), 'skipped');
  });

  it('reconcilia un cobro ya hecho (proceso caído) sin cobrar de nuevo', async () => {
    const { user, business } = await makeOwner('Dora');
    await duePlan(business);
    const card = await addCard(business, user, 'pm_card_visa');
    const s = await sub(business);
    const key = renewalKeyFor(s);
    await chargeOffSession({ customerId: card.customerId, paymentMethodId: card.pmId, amountMXN: 429, description: 'caida', metadata: { renewalKey: key } });
    assert.equal(await renewSubscription(s._id), 'renewed');
    assert.equal((await charges(card.customerId, key)).length, 1);
  });

  it('tres procesos a la vez → un solo cobro', async () => {
    const { user, business } = await makeOwner('Eli');
    await duePlan(business);
    const { customerId } = await addCard(business, user, 'pm_card_visa');
    const id = (await sub(business))._id;
    const rs = await Promise.all([renewSubscription(id), renewSubscription(id), renewSubscription(id)]);
    assert.equal(rs.filter((r) => r === 'renewed').length, 1);
    assert.equal((await charges(customerId)).length, 1);
  });

  it('tarjeta rechazada y 3DS → vencida con el motivo', async () => {
    const a = await makeOwner('Fer');
    await duePlan(a.business);
    await addCard(a.business, a.user, 'pm_card_chargeCustomerFail');
    await renewSubscription((await sub(a.business))._id);
    assert.equal((await sub(a.business)).status, 'vencida');
    assert.match((await sub(a.business)).lastRenewalError, /declin|fail/i);

    const b = await makeOwner('Gus');
    await duePlan(b.business);
    await addCard(b.business, b.user, 'pm_card_authenticationRequired');
    await renewSubscription((await sub(b.business))._id);
    assert.equal((await sub(b.business)).lastRenewalError, 'authentication_required');
  });

  describe('API de facturación', () => {
    let o, other, T, T2;
    const H = (t, b) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, 'X-Business-Id': String(b || '') });
    const login = async (u, pw) =>
      (await (await fetch(`${A}/auth/login`, { method: 'POST', headers: H(''), body: JSON.stringify({ email: u.email, password: pw }) })).json()).data.accessToken;
    const call = async (m, p, body, t = T, b = o.business._id) => {
      const r = await fetch(A + p, { method: m, headers: H(t, b), body: body ? JSON.stringify(body) : undefined });
      return [r.status, await r.json().catch(() => null)];
    };

    before(async () => {
      o = await makeOwner('Pago');
      other = await makeOwner('Otro');
      T = await login(o.user, o.password);
      T2 = await login(other.user, other.password);
      // Pagar y tocar la tarjeta exigen confirmar identidad (modo sudo, 10 min).
      const step = (t, pw) => fetch(`${A}/auth/step-up`, { method: 'POST', headers: H(t), body: JSON.stringify({ password: pw }) });
      assert.equal((await step(T, o.password)).status, 200);
      assert.equal((await step(T2, other.password)).status, 200);
    });

    it('sin confirmar identidad no se puede pagar', async () => {
      const fresh = await makeOwner('Sudo');
      const Tf = await login(fresh.user, fresh.password);
      const r = await fetch(`${A}/billing/intent`, { method: 'POST', headers: H(Tf, fresh.business._id), body: JSON.stringify({ kind: 'credits', packKey: 'pack_100k' }) });
      assert.equal(r.status, 403);
      assert.equal((await r.json()).details?.code, 'STEP_UP_REQUIRED');
    });

    it('el onboarding no activa planes de pago', async () => {
      const r = await fetch(`${A}/onboarding`, { method: 'POST', headers: H(T2), body: JSON.stringify({ planKey: 'elite', business: { name: 'x' } }) });
      assert.equal(r.status, 402);
    });

    it('tarjeta primero, tarjeta ajena rechazada y confirm idempotente', async () => {
      let [st] = await call('POST', '/billing/intent', { kind: 'credits', packKey: 'pack_100k' });
      assert.equal(st, 400);

      const [, si] = await call('POST', '/billing/setup-intent');
      const conf = await stripe.setupIntents.confirm(si.data.clientSecret.split('_secret_')[0], { payment_method: 'pm_card_visa', return_url: 'https://example.com' });
      [st] = await call('POST', '/billing/payment-method', { paymentMethodId: conf.payment_method });
      assert.equal(st, 200);

      const foreign = await stripe.paymentMethods.create({ type: 'card', card: { token: 'tok_visa' } });
      [st] = await call('POST', '/billing/payment-method', { paymentMethodId: foreign.id });
      assert.equal(st, 403);

      const before = (await Subscription.findOne({ business: o.business._id })).extraTokens;
      const [, intent] = await call('POST', '/billing/intent', { kind: 'credits', packKey: 'pack_100k' });
      assert.equal(intent.data.status, 'succeeded');
      const rs = await Promise.all([1, 2, 3].map(() => call('POST', '/billing/confirm', { paymentIntentId: intent.data.paymentIntentId })));
      const afterT = (await Subscription.findOne({ business: o.business._id })).extraTokens;
      assert.equal(afterT - before, 100000);
      // Ya se entregó en el servidor al cobrar: los 3 confirm solo lo confirman.
      assert.equal(rs.filter(([, j]) => j?.data?.alreadyProcessed).length, 3);

      [st] = await call('POST', '/billing/confirm', { paymentIntentId: intent.data.paymentIntentId }, T2, other.business._id);
      assert.equal(st, 403);
    });

    it('mejora de plan, tarjeta protegida y renovación manual con candado', async () => {
      let [st, js] = await call('POST', '/billing/intent', { kind: 'plan', planKey: 'pro' });
      [st, js] = await call('POST', '/billing/confirm', { paymentIntentId: js.data.paymentIntentId });
      assert.equal(st, 200); // ya entregado al cobrar
      assert.equal(js.data.upgraded, true);
      [st] = await call('POST', '/billing/intent', { kind: 'plan', planKey: 'pro' });
      assert.equal(st, 400);
      [st] = await call('DELETE', '/billing/payment-method');
      assert.equal(st, 409);

      [st] = await call('POST', '/billing/intent', { kind: 'renewal' });
      assert.equal(st, 400);
      await Subscription.updateOne(
        { business: o.business._id },
        { $set: { renewalDate: new Date(Date.now() - 3600e3), status: 'vencida', pastDueSince: new Date(), tokensUsedThisPeriod: 5000 } }
      );
      [st, js] = await call('POST', '/billing/intent', { kind: 'renewal' });
      // La primera ya se cobró y entregó al momento: un segundo intento no
      // encuentra renovación pendiente (nunca cobra dos veces).
      const [st2] = await call('POST', '/billing/intent', { kind: 'renewal' });
      assert.equal(st2, 400);
      [st] = await call('POST', '/billing/confirm', { paymentIntentId: js.data.paymentIntentId });
      const s = await Subscription.findOne({ business: o.business._id });
      assert.equal(s.status, 'activa');
      assert.equal(s.tokensUsedThisPeriod, 0);
      assert.ok(s.renewalDate > new Date());

      await call('POST', '/billing/cancel');
      [st] = await call('DELETE', '/billing/payment-method');
      assert.equal(st, 200);
      [st] = await call('POST', '/billing/resume');
      assert.equal(st, 400);
    });
  });
});
