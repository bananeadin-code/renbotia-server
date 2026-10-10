// Recordatorios de citas con confirmación (Gestión, Elite).
import { setupDb, teardownDb, makeOwner, DAY } from './helpers.mjs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const H = 3600e3;

describe('Recordatorios de citas', () => {
  let Business, Plan, Subscription, ChatSimulation, ManagedRecord, ManagementConfig, svc;
  const sent = { text: [], template: [], ig: [] };

  before(async () => {
    await setupDb();
    ({ Business } = await import('../src/models/Business.js'));
    ({ Plan } = await import('../src/models/Plan.js'));
    ({ Subscription } = await import('../src/models/Subscription.js'));
    ({ ChatSimulation } = await import('../src/models/ChatSimulation.js'));
    ({ ManagedRecord } = await import('../src/models/ManagedRecord.js'));
    ({ ManagementConfig } = await import('../src/models/ManagementConfig.js'));
    svc = await import('../src/services/reminder.service.js');
    svc.__setReminderTestHooks({
      sendText: async (a) => (sent.text.push(a), { ok: true }),
      sendInstagramText: async (a) => (sent.ig.push(a), { ok: true }),
      sendMessengerText: async () => ({ ok: true }),
      sendTemplate: async (a) => (sent.template.push(a), { ok: true }),
      listTemplates: async () => ({
        templates: [
          {
            name: 'recordatorio_cita',
            language: 'es_MX',
            status: 'APPROVED',
            usable: true,
            bodyText: 'Hola {{1}}, te esperamos el {{2}} a las {{3}}. ¿Confirmas?',
            vars: ['1', '2', '3'],
            named: false,
          },
        ],
      }),
    });
  });
  after(async () => {
    svc.__setReminderTestHooks(null);
    await teardownDb();
  });

  async function eliteBiz({ template = false } = {}) {
    const o = await makeOwner('Agenda');
    const elite = await Plan.findOne({ key: 'elite' });
    await Subscription.updateOne({ business: o.business._id }, { $set: { plan: elite._id } });
    await Business.updateOne({ _id: o.business._id }, { $set: { whatsappPhoneNumberId: `P${Date.now()}${Math.random()}`, whatsappWabaId: 'W1' } });
    await ManagementConfig.create({
      business: o.business._id,
      enabled: true,
      enabledTypes: ['cita'],
      reminders: {
        enabled: true,
        hoursBefore: 24,
        template: template ? { name: 'recordatorio_cita', language: 'es_MX', params: ['{nombre}', '{fecha}', '{hora}'] } : { name: '', language: '', params: [] },
      },
    });
    return o.business._id;
  }
  async function record(biz, { chat = null, inHours = 20, createdAgo = 3 * DAY, contact = '', name = 'Ana López', channel = null } = {}) {
    const r = await ManagedRecord.create({
      business: biz,
      type: 'cita',
      summary: 'Corte de cabello',
      customer: { name, contact },
      scheduledAt: new Date(Date.now() + inHours * H),
      source: chat ? 'bot' : 'manual',
      chat,
      channel,
    });
    await ManagedRecord.collection.updateOne({ _id: r._id }, { $set: { createdAt: new Date(Date.now() - createdAgo) } });
    return r;
  }
  const chatWith = (biz, channel, lastInboundAgo) =>
    ChatSimulation.create({
      business: biz,
      channel,
      customerPhone: channel === 'whatsapp' ? `52161${Math.floor(Math.random() * 1e8)}` : '',
      customerId: channel !== 'whatsapp' ? `ID${Math.random()}` : '',
      messages: [{ role: 'user', content: 'quiero una cita', timestamp: new Date(Date.now() - lastInboundAgo) }],
    });
  const status = async (id) => (await ManagedRecord.findById(id).lean()).reminder;

  it('lógica: cuándo toca, teléfono y texto del recordatorio', () => {
    const r = { type: 'cita', status: 'pendiente', scheduledAt: new Date(Date.now() + 10 * H), createdAt: new Date(Date.now() - 3 * DAY) };
    assert.equal(svc.reminderDue(r, 24), true);
    assert.equal(svc.reminderDue({ ...r, scheduledAt: new Date(Date.now() + 30 * H) }, 24), false, 'aún falta');
    assert.equal(svc.reminderDue({ ...r, status: 'cancelado' }, 24), false);
    assert.equal(svc.reminderDue({ ...r, reminder: { status: 'sent' } }, 24), false, 'una sola vez');
    assert.equal(svc.reminderDue({ ...r, type: 'pedido' }, 24), false);
    assert.equal(svc.bookedTooClose({ ...r, createdAt: new Date() }, 24), true);
    assert.equal(svc.normalizeWaPhone('618 123 4567'), '526181234567');
    assert.equal(svc.normalizeWaPhone('+52 1 618 123 4567'), '5216181234567');
    assert.equal(svc.normalizeWaPhone('ana@correo.com'), '');
    const t = svc.reminderText({ ...r, summary: 'Corte', customer: { name: 'Ana López' } }, 'Barbería Max', 'America/Mexico_City');
    assert.match(t, /Hola Ana/);
    assert.match(t, /Barbería Max/);
    assert.match(t, /confirmas/);
  });

  it('envía por texto dentro de 24 h, por plantilla fuera, y omite lo que no se puede', async () => {
    const biz = await eliteBiz({ template: true });
    const open = await chatWith(biz, 'whatsapp', 2 * H);
    const closed = await chatWith(biz, 'whatsapp', 3 * DAY);
    const web = await chatWith(biz, 'web', 1 * H);
    const rOpen = await record(biz, { chat: open._id });
    const rClosed = await record(biz, { chat: closed._id });
    const rManual = await record(biz, { contact: '618 555 0101', name: 'Luis Pérez' });
    const rWeb = await record(biz, { chat: web._id });
    const rClose = await record(biz, { chat: open._id, inHours: 5, createdAgo: 1 * H });
    const rFar = await record(biz, { chat: open._id, inHours: 40 });

    sent.text.length = 0;
    sent.template.length = 0;
    await svc.runReminders();

    assert.equal((await status(rOpen._id)).status, 'sent');
    assert.equal((await status(rOpen._id)).via, 'text');
    assert.ok(sent.text.some((m) => m.to === open.customerPhone && /confirmas/.test(m.text)));

    assert.equal((await status(rClosed._id)).via, 'template');
    const tpl = sent.template.find((m) => m.to === closed.customerPhone);
    assert.equal(tpl.templateName, 'recordatorio_cita');
    assert.equal(tpl.bodyParams[0].text, 'Ana');

    // Cita hecha a mano con teléfono: crea la conversación y le llega por plantilla.
    const man = await ManagedRecord.findById(rManual._id).lean();
    assert.equal(man.reminder.status, 'sent');
    const manChat = await ChatSimulation.findById(man.chat).lean();
    assert.equal(manChat.customerPhone, '526181555010'.slice(0, 2) + '6185550101');
    assert.equal(manChat.messages.at(-1).role, 'assistant');

    assert.equal((await status(rWeb._id)).status, 'skipped');
    assert.match((await status(rClose._id)).note, /poca anticipación/);
    assert.equal((await status(rFar._id)).status, '', 'aún no toca');

    // Una segunda pasada no repite nada.
    const before = sent.text.length + sent.template.length;
    await svc.runReminders();
    assert.equal(sent.text.length + sent.template.length, before);
  });

  it('sin plantilla y fuera de 24 h: se omite y queda anotado; con el canal en pausa: espera', async () => {
    const biz = await eliteBiz({ template: false });
    const closed = await chatWith(biz, 'whatsapp', 3 * DAY);
    const r = await record(biz, { chat: closed._id });
    const ig = await chatWith(biz, 'instagram', 1 * H);
    const rIg = await record(biz, { chat: ig._id });
    await Business.updateOne({ _id: biz }, { $set: { 'channelSettings.instagram.paused': true } });
    await svc.runReminders();
    assert.match((await status(r._id)).note, /sin plantilla/);
    assert.equal((await status(rIg._id)).status || '', '', 'en pausa: se reintenta después');
    await Business.updateOne({ _id: biz }, { $set: { 'channelSettings.instagram.paused': false } });
    sent.ig.length = 0;
    await svc.runReminders();
    assert.equal((await status(rIg._id)).status, 'sent');
    assert.equal(sent.ig.length, 1);
  });

  it('solo Elite con Gestión activa', async () => {
    const biz = await eliteBiz();
    const pro = await Plan.findOne({ key: 'pro' });
    await Subscription.updateOne({ business: biz }, { $set: { plan: pro._id } });
    const chat = await chatWith(biz, 'whatsapp', 1 * H);
    const r = await record(biz, { chat: chat._id });
    await svc.runReminders();
    assert.equal((await status(r._id)).status, '');
  });

  it('la respuesta del cliente confirma, cancela o pide cambio', async () => {
    const biz = await eliteBiz();
    const chat = await chatWith(biz, 'whatsapp', 1 * H);
    const a = await record(biz, { chat: chat._id });
    await ManagedRecord.updateOne({ _id: a._id }, { $set: { 'reminder.status': 'sent' } });
    const pending = await svc.pendingReminderFor(biz, chat._id);
    assert.equal(String(pending._id), String(a._id));
    assert.match(svc.reminderNote(pending, 'America/Mexico_City'), /RECORDATORIO PENDIENTE/);

    await svc.answerReminder(pending, 'confirma', 'ahí estaré');
    let r = await ManagedRecord.findById(a._id).lean();
    assert.equal(r.status, 'confirmado');
    assert.equal(r.reminder.status, 'confirmed');
    assert.equal(await svc.pendingReminderFor(biz, chat._id), null, 'ya respondió');

    const b = await record(biz, { chat: chat._id, inHours: 22 });
    await ManagedRecord.updateOne({ _id: b._id }, { $set: { 'reminder.status': 'sent' } });
    await svc.answerReminder(await ManagedRecord.findById(b._id).lean(), 'cancela');
    r = await ManagedRecord.findById(b._id).lean();
    assert.equal(r.status, 'cancelado');

    const c = await record(biz, { chat: chat._id, inHours: 23 });
    await ManagedRecord.updateOne({ _id: c._id }, { $set: { 'reminder.status': 'sent' } });
    const out = await svc.answerReminder(await ManagedRecord.findById(c._id).lean(), 'cambiar', 'mejor el viernes');
    assert.match(out.escalate, /cambiar/);
    assert.equal((await ManagedRecord.findById(c._id).lean()).reminder.status, 'reschedule');
  });
});

describe('Pausa del chat del sitio web', () => {
  it('el bot no contesta en el sitio si está en pausa (el mensaje queda para el equipo)', async () => {
    const { botAvailability } = await import('../src/utils/botAvailability.js');
    const business = { channelSettings: { web: { paused: true, pausedUntil: null } } };
    assert.deepEqual(botAvailability({ business, schedule: null, channel: 'web', source: 'web' }), { reply: false, reason: 'channel_paused', closed: false });
    const later = { channelSettings: { web: { paused: true, pausedUntil: new Date(Date.now() - 1000) } } };
    assert.equal(botAvailability({ business: later, schedule: null, channel: 'web', source: 'web' }).reply, true, 'la pausa con hora vence sola');
  });
});
