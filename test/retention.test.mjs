// Retención: cancelar con motivo (CRM + aviso), oferta del anual una sola vez,
// aviso de tarjeta por vencer y clientes que pagan sin conversaciones.
import { DAY, setupDb, teardownDb, makeOwner } from './helpers.mjs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

describe('retención de clientes', () => {
  let srv, A, Subscription, Plan, Payment, Lead, Session, BillingProfile, ChatSimulation, User, startSession, retention, env;

  before(async () => {
    await setupDb();
    ({ Subscription } = await import('../src/models/Subscription.js'));
    ({ Plan } = await import('../src/models/Plan.js'));
    ({ Payment } = await import('../src/models/Payment.js'));
    ({ Lead } = await import('../src/models/Lead.js'));
    ({ Session } = await import('../src/models/Session.js'));
    ({ BillingProfile } = await import('../src/models/BillingProfile.js'));
    ({ ChatSimulation } = await import('../src/models/ChatSimulation.js'));
    ({ User } = await import('../src/models/User.js'));
    ({ startSession } = await import('../src/services/session.service.js'));
    ({ env } = await import('../src/config/env.js'));
    retention = await import('../src/services/retention.service.js');
    const { createApp } = await import('../src/app.js');
    srv = createApp().listen(0);
    A = `http://127.0.0.1:${srv.address().port}/api`;
  });
  after(async () => {
    srv?.close();
    await teardownDb();
  });

  const subOf = (o) => Subscription.findOne({ business: o.business._id }).populate('plan');
  async function paying(o, key = 'pro', set = {}) {
    const plan = await Plan.findOne({ key });
    await Subscription.updateOne(
      { business: o.business._id },
      { $set: { plan: plan._id, periodPaidMXN: plan.priceMXN, currentPeriodStart: new Date(Date.now() - 5 * DAY), renewalDate: new Date(Date.now() + 25 * DAY), ...set } }
    );
  }
  const tokenFor = async (o) => {
    const { accessToken } = await startSession({ user: o.user, silent: true, context: { kind: 'owner', business: o.business._id } });
    await Session.updateMany({ user: o.user._id }, { $set: { stepUpAt: new Date() } });
    return accessToken;
  };

  it('cancelar con motivo: guarda el motivo, deja nota en el CRM y seguimiento para hoy', async () => {
    const o = await makeOwner('Cancela');
    await paying(o, 'elite');
    const r = await fetch(`${A}/billing/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await tokenFor(o)}` },
      body: JSON.stringify({ reason: 'precio', comment: 'Por ahora no me alcanza' }),
    });
    assert.equal(r.status, 200);
    const s = await subOf(o);
    assert.equal(s.status, 'cancelada');
    assert.equal(s.cancelReason, 'precio');
    assert.equal(s.cancelComment, 'Por ahora no me alcanza');
    assert.ok(s.canceledAt);
    // La nota del CRM se escribe en segundo plano.
    let lead;
    for (let i = 0; i < 20 && !lead?.notes?.length; i++) {
      await new Promise((res) => setTimeout(res, 50));
      lead = await Lead.findOne({ user: o.user._id }).lean();
    }
    assert.match(lead.notes.at(-1).text, /Motivo: Es muy caro para mí/);
    assert.ok(lead.nextFollowUpAt <= new Date(), 'queda en seguimiento para hoy');
    // Motivo inválido: se rechaza.
    const bad = await fetch(`${A}/billing/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await tokenFor(o)}` },
      body: JSON.stringify({ reason: 'inventado' }),
    });
    assert.equal(bad.status, 400);
  });

  it('mensaje desde Ayuda: queda en la ficha del cliente con seguimiento para hoy', async () => {
    const o = await makeOwner('Ayuda');
    const send = (body, token) =>
      fetch(`${A}/support/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'CF-Connecting-IP': `10.11.${Math.floor(Math.random() * 250)}.1` },
        body: JSON.stringify(body),
      });
    const token = await tokenFor(o);
    const r = await send({ topic: 'Conexión de WhatsApp', message: 'No me llega el código de verificación al número.' }, token);
    assert.equal(r.status, 200);
    const lead = await Lead.findOne({ user: o.user._id }).lean();
    assert.match(lead.notes.at(-1).text, /Mensaje desde Ayuda \(Conexión de WhatsApp\): No me llega el código/);
    assert.ok(lead.nextFollowUpAt <= new Date());
    assert.equal((await send({ message: 'corto' }, token)).status, 400, 'valida el mensaje');
    const anon = await fetch(`${A}/support/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(anon.status, 401, 'requiere sesión');
  });

  it('oferta del anual: días 20–25 de un mes pagado, una sola vez; nunca a regalo, cortesía ni anual', async () => {
    const day21 = { currentPeriodStart: new Date(Date.now() - 21 * DAY), renewalDate: new Date(Date.now() + 9 * DAY) };
    const yes = await makeOwner('OfertaSi');
    await paying(yes, 'pro', day21);
    const early = await makeOwner('OfertaTemprano');
    await paying(early, 'pro'); // día 5
    const gift = await makeOwner('OfertaRegalo');
    await paying(gift, 'pro', { ...day21, periodPaidMXN: 0, pendingPlanKey: 'free' });
    const comp = await makeOwner('OfertaCortesia');
    await paying(comp, 'pro', { ...day21, complimentary: true });
    const annual = await makeOwner('OfertaAnual');
    await paying(annual, 'pro', { ...day21, billingCycle: 'anual', termEndsAt: new Date(Date.now() + 300 * DAY) });

    assert.equal((await retention.sendAnnualOffers()).sent, 1);
    assert.ok((await subOf(yes)).annualOfferSentAt);
    for (const o of [early, gift, comp, annual]) assert.equal((await subOf(o)).annualOfferSentAt, null);
    assert.equal((await retention.sendAnnualOffers()).sent, 0, 'nunca dos veces');
  });

  it('tarjeta por vencer: avisa una vez por tarjeta y solo si hay algo que cobrar', async () => {
    const now = new Date();
    const expiringPm = (id) => ({ id, brand: 'visa', last4: '4242', expMonth: now.getUTCMonth() + 1, expYear: now.getUTCFullYear() });
    const a = await makeOwner('TarjetaPlan');
    await paying(a, 'pro');
    await BillingProfile.updateOne({ business: a.business._id }, { $set: { business: a.business._id, paymentMethod: expiringPm('pm_vence_1') } }, { upsert: true });
    const free = await makeOwner('TarjetaFree');
    await BillingProfile.updateOne({ business: free.business._id }, { $set: { business: free.business._id, paymentMethod: expiringPm('pm_vence_2') } }, { upsert: true });
    const far = await makeOwner('TarjetaLejos');
    await paying(far, 'pro');
    await BillingProfile.updateOne(
      { business: far.business._id },
      { $set: { business: far.business._id, paymentMethod: { ...expiringPm('pm_lejos'), expYear: now.getUTCFullYear() + 3 } } },
      { upsert: true }
    );

    assert.equal((await retention.sendCardExpiryNotices(now)).sent, 1);
    assert.equal((await BillingProfile.findOne({ business: a.business._id })).cardExpiryNoticeFor, 'pm_vence_1');
    assert.equal((await retention.sendCardExpiryNotices(now)).sent, 0, 'una vez por tarjeta');
    // Cambia la tarjeta por otra que también vence: nuevo aviso para la nueva.
    await BillingProfile.updateOne({ business: a.business._id }, { $set: { paymentMethod: expiringPm('pm_vence_3') } });
    assert.equal((await retention.sendCardExpiryNotices(now)).sent, 1);
  });

  it('clientes que pagan sin conversaciones en 7 días (no recién llegados ni simulador)', async () => {
    const idle = await makeOwner('SinUso');
    await paying(idle);
    await Payment.collection.insertOne({ user: idle.user._id, business: idle.business._id, type: 'plan', amountMXN: 479, stripeSessionId: 'pi_idle', status: 'completed', createdAt: new Date(Date.now() - 10 * DAY) });
    await ChatSimulation.create({ business: idle.business._id, channel: 'simulator', messages: [] }); // pruebas no cuentan

    const active = await makeOwner('ConUso');
    await paying(active);
    await Payment.collection.insertOne({ user: active.user._id, business: active.business._id, type: 'plan', amountMXN: 479, stripeSessionId: 'pi_active', status: 'completed', createdAt: new Date(Date.now() - 10 * DAY) });
    await ChatSimulation.create({ business: active.business._id, channel: 'whatsapp', customerPhone: '5218180000000', messages: [] });

    const fresh = await makeOwner('Nuevo');
    await paying(fresh);
    await Payment.collection.insertOne({ user: fresh.user._id, business: fresh.business._id, type: 'plan', amountMXN: 479, stripeSessionId: 'pi_fresh', status: 'completed', createdAt: new Date(Date.now() - 2 * DAY) });

    const list = await retention.inactivePayingCustomers(new Date(), 7);
    const ids = list.map((c) => c.businessId);
    assert.ok(ids.includes(String(idle.business._id)), 'detecta al que no usa el bot');
    assert.ok(!ids.includes(String(active.business._id)), 'quien conversa no aparece');
    assert.ok(!ids.includes(String(fresh.business._id)), 'quien acaba de pagar no aparece');
    const row = list.find((c) => c.businessId === String(idle.business._id));
    assert.equal(row.email, idle.user.email);

    // Aparece en el resumen diario del equipo.
    env.funnel.alertEmails = ['equipo@test.dev'];
    try {
      const { sendDailyDigest } = await import('../src/services/funnel.service.js');
      const r = await sendDailyDigest(new Date());
      assert.ok(r.inactive >= 1);
    } finally {
      env.funnel.alertEmails = [];
    }
  });
});
