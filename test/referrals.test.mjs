// Referidos sin abuso y datos por contexto (dueño vs colaborador).
import { setupDb, teardownDb, makeOwner } from './helpers.mjs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

describe('referidos: el regalo no se puede aprovechar con cuentas falsas', () => {
  let User, Subscription, Plan, Membership, Session, AuditLog, ref, provisionBusiness, startSession, createApp, srv, A;

  before(async () => {
    await setupDb();
    ({ User } = await import('../src/models/User.js'));
    ({ Subscription } = await import('../src/models/Subscription.js'));
    ({ Plan } = await import('../src/models/Plan.js'));
    ({ Membership } = await import('../src/models/Membership.js'));
    ({ Session } = await import('../src/models/Session.js'));
    ({ AuditLog } = await import('../src/models/AuditLog.js'));
    ref = await import('../src/services/referral.service.js');
    ({ provisionBusiness } = await import('../src/services/business.service.js'));
    ({ startSession } = await import('../src/services/session.service.js'));
    ({ createApp } = await import('../src/app.js'));
    srv = createApp().listen(0);
    A = `http://127.0.0.1:${srv.address().port}/api`;
  });
  after(async () => {
    srv?.close();
    await teardownDb();
  });

  let seq = 0;
  async function referred(referrerId, { withBusiness = true } = {}) {
    seq += 1;
    const u = await User.create({ name: `Ref${seq}`, email: `ref${seq}.${Date.now()}@test.dev`, emailVerified: true, referredBy: referrerId });
    if (withBusiness) await provisionBusiness({ owner: u._id, planKey: 'free', business: { name: `Negocio ${seq}` } });
    return u;
  }
  const planOf = async (b) => (await Subscription.findOne({ business: b._id }).populate('plan')).plan.key;

  it('crear un negocio vacío ya no cuenta; conectar un canal sí', async () => {
    const o = await makeOwner('Inv');
    const r1 = await referred(o.user._id);
    const r2 = await referred(o.user._id);
    const r3 = await referred(o.user._id);
    assert.equal((await ref.referralSummary(o.user._id)).qualified, 0, 'tres negocios vacíos no cuentan');
    assert.equal(await planOf(o.business), 'free');
    for (const r of [r1, r2, r3]) await ref.qualifyReferral(r._id); // (al conectar su canal)
    assert.equal(await planOf(o.business), 'pro', 'tres negocios reales: mes de Pro');
  });

  it('no cuentan los de tu propio equipo ni los creados desde tu mismo dispositivo y red', async () => {
    const o = await makeOwner('Abuso');
    const teammate = await referred(o.user._id);
    await Membership.create({ business: o.business._id, user: teammate._id, role: 'colaborador' });
    await ref.qualifyReferral(teammate._id);
    assert.equal((await User.findById(teammate._id)).referralQualifiedAt, null);

    const ctx = { ip: '200.1.1.1', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0', country: 'MX' };
    await startSession({ user: o.user, ctx, silent: true });
    const clone = await referred(o.user._id);
    await startSession({ user: clone, ctx, silent: true });
    await ref.qualifyReferral(clone._id);
    assert.equal((await User.findById(clone._id)).referralQualifiedAt, null, 'misma PC y misma red = misma persona');
    assert.equal((await ref.referralSummary(o.user._id)).qualified, 0);
  });

  it('si quien invita aún no tiene negocio, el regalo espera y se entrega al crearlo', async () => {
    const u = await User.create({ name: 'SinNegocio', email: `sin${Date.now()}@test.dev`, emailVerified: true });
    for (let i = 0; i < 3; i++) {
      const r = await referred(u._id);
      await ref.qualifyReferral(r._id);
    }
    assert.equal((await User.findById(u._id)).referralRewards || 0, 0, 'no se consume sin negocio');
    const { business } = await provisionBusiness({ owner: u._id, planKey: 'free', business: { name: 'Al fin' } });
    assert.equal(await planOf(business), 'pro');
    assert.equal((await User.findById(u._id)).referralRewards, 1);
  });

  it('un colaborador no ve pagos ni la tarjeta, y la bitácora le oculta lo de dinero', async () => {
    const owner = await makeOwner('Dueno');
    const colab = await makeOwner('Colab');
    await Membership.create({ business: owner.business._id, user: colab.user._id, role: 'colaborador' });
    await AuditLog.create({ business: owner.business._id, user: owner.user._id, action: 'credits.purchase', summary: 'Compró 1 millón de créditos.' });
    await AuditLog.create({ business: owner.business._id, user: owner.user._id, action: 'botconfig.update', summary: 'Actualizó el entrenamiento.' });
    const { accessToken } = await startSession({
      user: colab.user,
      silent: true,
      context: { kind: 'member', business: owner.business._id },
    });
    const H = { Authorization: `Bearer ${accessToken}` };
    assert.equal((await fetch(`${A}/billing/payments`, { headers: H })).status, 403);
    assert.equal((await fetch(`${A}/billing/payment-method`, { headers: H })).status, 403);
    const audit = await (await fetch(`${A}/business/audit`, { headers: H })).json();
    const actions = audit.data.logs.map((l) => l.action);
    assert.ok(actions.includes('botconfig.update'));
    assert.ok(!actions.includes('credits.purchase'));
  });
});
