// Billetera de tokens y periodos gratis (sin Stripe).
import { DAY, setupDb, teardownDb, makeOwner } from './helpers.mjs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { Subscription } = await import('../src/models/Subscription.js');
const { Plan } = await import('../src/models/Plan.js');
const { applyLazyReset, deductTokens, addExtraTokens, computeBalance } = await import('../src/services/token.service.js');
const { renewSubscription } = await import('../src/services/renewal.service.js');

const sub = (b) => Subscription.findOne({ business: b._id }).populate('plan');
async function setPlan(b, key, set = {}) {
  const plan = await Plan.findOne({ key });
  await Subscription.updateOne({ business: b._id }, { $set: { plan: plan._id, ...set } });
}

describe('billetera y renovación gratis', () => {
  before(setupDb);
  after(teardownDb);

  it('descuentos simultáneos no se pisan (atómico)', async () => {
    const { business } = await makeOwner('Kim');
    await setPlan(business, 'pro', { tokensUsedThisPeriod: 0, extraTokens: 0 });
    const copies = await Promise.all(Array.from({ length: 10 }, () => sub(business)));
    await Promise.all(copies.map((c) => deductTokens(c, 1000)));
    await addExtraTokens(await sub(business), 500);
    const s = await sub(business);
    assert.equal(s.tokensUsedThisPeriod, 10000);
    assert.equal(s.extraTokens, 500);
  });

  it('al agotar el cupo descuenta de los créditos extra sin quedar negativo', async () => {
    const { business } = await makeOwner('Ext');
    await setPlan(business, 'free', { tokensUsedThisPeriod: 0, extraTokens: 300 });
    let s = await sub(business);
    const limit = s.plan.monthlyTokenLimit;
    await deductTokens(s, limit + 1000); // pide más de lo que hay
    s = await sub(business);
    assert.equal(s.tokensUsedThisPeriod, limit);
    assert.equal(s.extraTokens, 0);
    assert.equal(computeBalance(s).available, 0);
  });

  it('el reseteo perezoso NO regala un mes de un plan de pago', async () => {
    const { business } = await makeOwner('Juan');
    await setPlan(business, 'pro', { renewalDate: new Date(Date.now() - DAY), tokensUsedThisPeriod: 1000 });
    await applyLazyReset(await sub(business));
    const s = await sub(business);
    assert.equal(s.plan.key, 'pro');
    assert.equal(s.tokensUsedThisPeriod, 1000);
    assert.ok(s.renewalDate < new Date());
  });

  it('Free vencido se renueva gratis con cupo nuevo', async () => {
    const { business } = await makeOwner('Free');
    await setPlan(business, 'free', { renewalDate: new Date(Date.now() - DAY), tokensUsedThisPeriod: 999 });
    await applyLazyReset(await sub(business));
    const s = await sub(business);
    assert.equal(s.tokensUsedThisPeriod, 0);
    assert.ok(s.renewalDate > new Date());
  });

  it('cancelada y fin del regalo de referidos bajan a Free sin cobrar', async () => {
    const { business: h } = await makeOwner('Hugo');
    const { business: i } = await makeOwner('Iris');
    await setPlan(h, 'pro', { renewalDate: new Date(Date.now() - DAY), status: 'cancelada' });
    await setPlan(i, 'pro', { renewalDate: new Date(Date.now() - DAY), pendingPlanKey: 'free' });
    assert.equal(await renewSubscription((await sub(h))._id), 'free');
    assert.equal(await renewSubscription((await sub(i))._id), 'free');
    assert.equal((await sub(h)).plan.key, 'free');
    assert.equal((await sub(i)).plan.key, 'free');
  });

  it('plan de pago sin tarjeta queda vencido (sin cupo nuevo) y en gracia', async () => {
    const { business } = await makeOwner('Ana');
    await setPlan(business, 'pro', { renewalDate: new Date(Date.now() - DAY), tokensUsedThisPeriod: 1000 });
    assert.equal(await renewSubscription((await sub(business))._id), 'failed');
    const s = await sub(business);
    assert.equal(s.status, 'vencida');
    assert.equal(s.lastRenewalError, 'no_card');
    assert.equal(s.tokensUsedThisPeriod, 1000);
    assert.ok(s.pastDueSince && s.nextRenewalAttemptAt > new Date());
  });

  it('al terminar la gracia baja a Free y conserva los créditos comprados', async () => {
    const { business } = await makeOwner('Fer');
    await setPlan(business, 'elite', {
      renewalDate: new Date(Date.now() - 5 * DAY),
      status: 'vencida',
      pastDueSince: new Date(Date.now() - 4 * DAY),
      extraTokens: 50000,
    });
    await renewSubscription((await sub(business))._id);
    const s = await sub(business);
    assert.equal(s.plan.key, 'free');
    assert.equal(s.extraTokens, 50000);
    assert.equal(s.status, 'activa');
  });
});
