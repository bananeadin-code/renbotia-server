// Entrega de compras sin depender del navegador + conciliador (Stripe MODO PRUEBA).
import { setupDb, teardownDb, makeOwner, hasStripeTest, stripeTest } from './helpers.mjs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const skip = !hasStripeTest && 'sin STRIPE_SECRET_KEY de prueba';

describe('entrega de compras y conciliación (Stripe modo prueba)', { skip }, () => {
  let stripe, Subscription, Plan, Payment, Session, ensureCustomer, startSession, fulfill, createApp, srv, A;

  before(async () => {
    await setupDb();
    stripe = await stripeTest();
    ({ Subscription } = await import('../src/models/Subscription.js'));
    ({ Plan } = await import('../src/models/Plan.js'));
    ({ Payment } = await import('../src/models/Payment.js'));
    ({ Session } = await import('../src/models/Session.js'));
    ({ ensureCustomer } = await import('../src/services/billingProfile.service.js'));
    ({ startSession } = await import('../src/services/session.service.js'));
    fulfill = await import('../src/services/fulfillment.service.js');
    ({ createApp } = await import('../src/app.js'));
    srv = createApp().listen(0);
    A = `http://127.0.0.1:${srv.address().port}/api`;
  });
  after(async () => {
    fulfill.__setFulfillmentTestHooks(null);
    srv?.close();
    await teardownDb();
  });

  async function ownerWithCard() {
    const o = await makeOwner('Compra');
    const { profile, customerId } = await ensureCustomer(o.business._id, o.user._id);
    const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: customerId });
    profile.paymentMethod = { id: pm.id, brand: pm.card.brand, last4: pm.card.last4, expMonth: pm.card.exp_month, expYear: pm.card.exp_year };
    await profile.save();
    const { accessToken } = await startSession({ user: o.user, silent: true, context: { kind: 'owner', business: o.business._id } });
    await Session.updateMany({ user: o.user._id }, { $set: { stepUpAt: new Date() } });
    return { ...o, customerId, pmId: pm.id, token: accessToken };
  }
  const call = async (path, token, body) => {
    const r = await fetch(`${A}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'CF-Connecting-IP': `10.5.${Math.floor(Math.random() * 250)}.1` },
      body: JSON.stringify(body),
    });
    return [r.status, await r.json().catch(() => null)];
  };

  it('compra de créditos: se entrega al cobrar aunque el navegador nunca confirme', async () => {
    const o = await ownerWithCard();
    const before = (await Subscription.findOne({ business: o.business._id })).extraTokens || 0;
    const [s, j] = await call('/billing/intent', o.token, { kind: 'credits', packKey: 'pack_100k' });
    assert.equal(s, 200, JSON.stringify(j));
    assert.equal(j.data.status, 'succeeded');
    // El navegador "se cerró": no llamamos a /billing/confirm.
    const after1 = (await Subscription.findOne({ business: o.business._id })).extraTokens;
    assert.ok(after1 > before, 'los créditos ya están');
    assert.equal(await Payment.countDocuments({ stripeSessionId: j.data.paymentIntentId }), 1);

    // Si el navegador sí confirma después, no se entrega dos veces.
    const [s2, j2] = await call('/billing/confirm', o.token, { paymentIntentId: j.data.paymentIntentId });
    assert.equal(s2, 200);
    assert.equal(j2.data.alreadyProcessed, true);
    assert.equal((await Subscription.findOne({ business: o.business._id })).extraTokens, after1);
  });

  it('mejora de plan: activa el plan en el servidor y confirm no la repite', async () => {
    const o = await ownerWithCard();
    const [, j] = await call('/billing/intent', o.token, { kind: 'plan', planKey: 'pro' });
    assert.equal(j.data.status, 'succeeded');
    const s = await Subscription.findOne({ business: o.business._id }).populate('plan');
    assert.equal(s.plan.key, 'pro');
    const [s2, j2] = await call('/billing/confirm', o.token, { paymentIntentId: j.data.paymentIntentId });
    assert.equal(s2, 200);
    assert.equal(j2.data.upgraded, true);
    assert.equal(await Payment.countDocuments({ business: o.business._id, type: 'plan' }), 1);
  });

  it('conciliador: entrega un pago cobrado que quedó sin entregar, una sola vez', async () => {
    const o = await ownerWithCard();
    // Cobro "huérfano": se cobró en Stripe pero el proceso murió antes de entregar.
    const pi = await stripe.paymentIntents.create({
      amount: 12900,
      currency: 'mxn',
      customer: o.customerId,
      payment_method: o.pmId,
      payment_method_types: ['card'],
      confirm: true,
      off_session: false,
      metadata: { type: 'credits', packKey: 'pack_100k', userId: String(o.user._id), businessId: String(o.business._id) },
    });
    assert.equal(pi.status, 'succeeded');
    const before = (await Subscription.findOne({ business: o.business._id })).extraTokens || 0;
    // Solo los pagos de este cliente (la cuenta de prueba tiene muchos más).
    fulfill.__setFulfillmentTestHooks({ list: (params) => stripe.paymentIntents.list({ ...params, customer: o.customerId }) });
    const r1 = await fulfill.reconcilePayments();
    assert.deepEqual(r1.fixed.map((f) => f.id), [pi.id]);
    const after1 = (await Subscription.findOne({ business: o.business._id })).extraTokens;
    assert.ok(after1 > before);
    const r2 = await fulfill.reconcilePayments();
    assert.equal(r2.fixed.length, 0, 'no vuelve a entregar');
    assert.equal((await Subscription.findOne({ business: o.business._id })).extraTokens, after1);
  });

  it('el conciliador ignora cobros que no son compras (recarga automática, renovación automática)', async () => {
    const o = await ownerWithCard();
    const mk = (metadata) =>
      stripe.paymentIntents.create({
        amount: 5000,
        currency: 'mxn',
        customer: o.customerId,
        payment_method: o.pmId,
        payment_method_types: ['card'],
        confirm: true,
        off_session: false,
        metadata,
      });
    await mk({ type: 'auto_recharge', packKey: 'pack_100k', businessId: String(o.business._id) });
    await mk({ type: 'renewal', renewalKey: 'x', subscriptionId: 'y', businessId: String(o.business._id), planKey: 'pro', userId: String(o.user._id) });
    fulfill.__setFulfillmentTestHooks({ list: (params) => stripe.paymentIntents.list({ ...params, customer: o.customerId }) });
    const r = await fulfill.reconcilePayments();
    assert.equal(r.fixed.length, 0);
  });
});
