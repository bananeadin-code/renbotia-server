// Plan de cortesía: se renueva cada mes sin cobro y sin bajar a Free.
import { setupDb, teardownDb, makeOwner, DAY } from './helpers.mjs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

describe('Plan de cortesía', () => {
  let Plan, Subscription, renewSubscription;
  before(async () => {
    await setupDb();
    ({ Plan } = await import('../src/models/Plan.js'));
    ({ Subscription } = await import('../src/models/Subscription.js'));
    ({ renewSubscription } = await import('../src/services/renewal.service.js'));
  });
  after(teardownDb);

  async function eliteVencida({ complimentary }) {
    const o = await makeOwner(complimentary ? 'Cortesia' : 'Normal');
    const elite = await Plan.findOne({ key: 'elite' });
    const due = new Date(Date.now() - DAY);
    await Subscription.updateOne(
      { business: o.business._id },
      { $set: { plan: elite._id, complimentary, renewalDate: due, currentPeriodStart: new Date(due - 30 * DAY), tokensUsedThisPeriod: 4_000_000 } }
    );
    return { o, due };
  }

  it('con cortesía: renueva sin cobro, sigue en Elite y reinicia el cupo', async () => {
    const { o, due } = await eliteVencida({ complimentary: true });
    const sub = await Subscription.findOne({ business: o.business._id });
    assert.equal(await renewSubscription(sub._id), 'free');
    const after = await Subscription.findOne({ business: o.business._id }).populate('plan');
    assert.equal(after.plan.key, 'elite');
    assert.equal(after.complimentary, true);
    assert.equal(after.tokensUsedThisPeriod, 0);
    assert.ok(after.renewalDate > due, 'el periodo avanzó');
    assert.equal(after.lastRenewalError, '');
  });

  it('sin cortesía y sin tarjeta: no se renueva gratis (sigue el flujo de cobro)', async () => {
    const { o } = await eliteVencida({ complimentary: false });
    const sub = await Subscription.findOne({ business: o.business._id });
    const r = await renewSubscription(sub._id);
    assert.notEqual(r, 'free');
    const after = await Subscription.findOne({ business: o.business._id });
    assert.equal(after.tokensUsedThisPeriod, 4_000_000, 'no recibe cupo nuevo sin pagar');
  });
});
