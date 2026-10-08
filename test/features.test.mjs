// Plantillas de seguimiento, PDF de clientes, archivos del widget y aviso por correo.
import { setupDb, teardownDb, makeOwner, DAY } from './helpers.mjs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { templateVars, summarizeTemplate, bodyParameters, renderTemplate, fillPlaceholders } = await import(
  '../src/utils/waTemplate.js'
);
const { isPdf, pdfPageCount, safeFileName } = await import('../src/utils/document.js');
const { isTemplateFollowUpDue } = await import('../src/services/followUp.service.js');

const HOUR = 3600e3;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Type /Page >> endobj\n3 0 obj << /Type /Pages >> endobj\n%%EOF');

describe('plantillas de WhatsApp', () => {
  it('lee variables posicionales y con nombre', () => {
    assert.deepEqual(templateVars('Hola {{1}}, tu pedido {{2}} y {{1}}'), ['1', '2']);
    const s = summarizeTemplate({
      name: 'x',
      language: 'es_MX',
      status: 'APPROVED',
      parameter_format: 'NAMED',
      components: [
        { type: 'BODY', text: 'Hola {{nombre}}' },
        { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Sí' }] },
      ],
    });
    assert.equal(s.named, true);
    assert.deepEqual(s.vars, ['nombre']);
    assert.deepEqual(s.quickReplies, ['Sí']);
    assert.equal(s.usable, true);
  });

  it('marca como no enviable una plantilla con encabezado multimedia', () => {
    const s = summarizeTemplate({ name: 'x', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hola' }] });
    assert.equal(s.usable, false);
  });

  it('llena {nombre}, arma parámetros y renderiza el texto final', () => {
    const values = fillPlaceholders(['{nombre}', 'tu cotización'], { customerName: 'María López' });
    assert.deepEqual(values, ['María', 'tu cotización']);
    assert.deepEqual(bodyParameters(['1', '2'], values, false), [
      { type: 'text', text: 'María' },
      { type: 'text', text: 'tu cotización' },
    ]);
    assert.equal(bodyParameters(['nombre'], ['Ana'], true)[0].parameter_name, 'nombre');
    assert.equal(renderTemplate('Hola {{1}}, sobre {{2}}', ['1', '2'], values), 'Hola María, sobre tu cotización');
    assert.deepEqual(fillPlaceholders(['{nombre}'], { customerName: '', fallback: 'amigo' }), ['amigo']);
  });

  it('decide cuándo toca el seguimiento con plantilla', () => {
    const now = Date.now();
    const base = (inboundAgo, extra = {}) => ({
      channel: 'whatsapp',
      customerPhone: '5215550000000',
      handoffMode: 'bot',
      needsAttention: false,
      messages: [
        { role: 'user', content: 'precio?', timestamp: new Date(now - inboundAgo) },
        { role: 'assistant', via: 'bot', content: 'Cuesta 100', timestamp: new Date(now - inboundAgo + 60e3) },
      ],
      ...extra,
    });
    assert.equal(isTemplateFollowUpDue(base(50 * HOUR), 48 * HOUR, now), true);
    assert.equal(isTemplateFollowUpDue(base(30 * HOUR), 48 * HOUR, now), false, 'antes del retraso');
    assert.equal(isTemplateFollowUpDue(base(8 * DAY), 48 * HOUR, now), false, 'más de 7 días');
    assert.equal(isTemplateFollowUpDue(base(50 * HOUR, { handoffMode: 'manual' }), 48 * HOUR, now), false);
    assert.equal(isTemplateFollowUpDue(base(50 * HOUR, { channel: 'facebook' }), 48 * HOUR, now), false);
    assert.equal(
      isTemplateFollowUpDue(base(50 * HOUR, { templateFollowUpAt: new Date(now - HOUR) }), 48 * HOUR, now),
      false,
      'uno por silencio'
    );
  });
});

describe('documentos', () => {
  it('reconoce PDF por su firma y cuenta páginas', () => {
    assert.equal(isPdf(PDF), true);
    assert.equal(isPdf(Buffer.from('<html>')), false);
    assert.equal(pdfPageCount(PDF), 2);
    assert.equal(safeFileName('../../etc/pass"wd.pdf'), '....etcpasswd.pdf');
  });
});

describe('API: archivos, widget y seguimiento', () => {
  let createApp, srv, A, ChatSimulation, ChatAttachment, Business, Subscription, Plan, BotConfig;
  before(async () => {
    await setupDb();
    ({ createApp } = await import('../src/app.js'));
    ({ ChatSimulation } = await import('../src/models/ChatSimulation.js'));
    ({ ChatAttachment } = await import('../src/models/ChatAttachment.js'));
    ({ Business } = await import('../src/models/Business.js'));
    ({ Subscription } = await import('../src/models/Subscription.js'));
    ({ Plan } = await import('../src/models/Plan.js'));
    ({ BotConfig } = await import('../src/models/BotConfig.js'));
    srv = createApp().listen(0);
    A = `http://127.0.0.1:${srv.address().port}/api`;
  });
  after(async () => {
    srv?.close();
    await teardownDb();
  });

  const H = (t, b) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, 'X-Business-Id': String(b || '') });
  const login = async (o) =>
    (await (await fetch(`${A}/auth/login`, { method: 'POST', headers: H(''), body: JSON.stringify({ email: o.user.email, password: o.password }) })).json()).data.accessToken;

  it('el PDF del cliente solo lo descarga su negocio', async () => {
    const a = await makeOwner('Ana');
    const b = await makeOwner('Beto');
    const chat = await ChatSimulation.create({ business: a.business._id, channel: 'whatsapp', customerPhone: '1', messages: [] });
    const att = await ChatAttachment.create({ business: a.business._id, chat: chat._id, name: 'cotizacion.pdf', mime: 'application/pdf', size: PDF.length, data: PDF });
    const Ta = await login(a);
    const Tb = await login(b);
    const ok = await fetch(`${A}/conversations/${chat._id}/files/${att._id}`, { headers: H(Ta, a.business._id) });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-disposition'), /attachment/);
    assert.equal(Buffer.from(await ok.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    const other = await fetch(`${A}/conversations/${chat._id}/files/${att._id}`, { headers: H(Tb, b.business._id) });
    assert.equal(other.status, 404);
  });

  it('el widget rechaza archivos si el plan no los lee, y archivos falsos', async () => {
    const o = await makeOwner('Wid');
    const pro = await Plan.findOne({ key: 'pro' });
    await Subscription.updateOne({ business: o.business._id }, { $set: { plan: pro._id } });
    await Business.updateOne({ _id: o.business._id }, { $set: { 'widget.enabled': true, 'widget.key': 'k'.repeat(20) } });
    const send = (body) =>
      fetch(`${A}/widget/public/${'k'.repeat(20)}/message`, { method: 'POST', headers: H(''), body: JSON.stringify({ sessionId: 's'.repeat(20), ...body }) });
    const cfg = await (await fetch(`${A}/widget/public/${'k'.repeat(20)}`)).json();
    assert.equal(cfg.data.allowFiles, false);
    const pdf = { kind: 'pdf', mediaType: 'application/pdf', data: PDF.toString('base64'), name: 'a.pdf' };
    assert.equal((await send({ file: pdf })).status, 403);

    const elite = await Plan.findOne({ key: 'elite' });
    await Subscription.updateOne({ business: o.business._id }, { $set: { plan: elite._id } });
    const fake = { kind: 'image', mediaType: 'image/png', data: Buffer.from('<script>').toString('base64') };
    assert.equal((await send({ file: fake })).status, 400);
    const notPdf = { kind: 'pdf', mediaType: 'application/pdf', data: Buffer.from('hola').toString('base64') };
    assert.equal((await send({ file: notPdf })).status, 400);
    assert.equal((await send({ message: '' })).status, 400, 'sin texto ni archivo');
  });

  it('el simulador valida los archivos igual que el chat del sitio', async () => {
    const o = await makeOwner('Sim');
    const T = await login(o);
    const send = (body) => fetch(`${A}/simulator/message`, { method: 'POST', headers: H(T, o.business._id), body: JSON.stringify(body) });
    assert.equal((await send({ message: '' })).status, 400, 'sin texto ni archivo');
    const fake = { kind: 'pdf', mediaType: 'application/pdf', data: Buffer.from('no soy pdf').toString('base64'), name: 'x.pdf' };
    assert.equal((await send({ file: fake })).status, 400, 'PDF falso');
    const badImg = { kind: 'image', mediaType: 'image/jpeg', data: Buffer.from('GIF89a').toString('base64') };
    assert.equal((await send({ file: badImg })).status, 400, 'imagen con firma que no corresponde');
  });

  it('guardar el seguimiento normal no borra la plantilla configurada', async () => {
    const o = await makeOwner('Tpl');
    const pro = await Plan.findOne({ key: 'pro' });
    await Subscription.updateOne({ business: o.business._id }, { $set: { plan: pro._id } });
    const T = await login(o);
    const put = (body) => fetch(`${A}/botconfig`, { method: 'PUT', headers: H(T, o.business._id), body: JSON.stringify(body) });
    let r = await put({ followUp: { enabled: true, delayHours: 4, mode: 'ai', template: { enabled: true, name: 'seguimiento_venta', delayHours: 48, params: ['{nombre}'] } } });
    assert.equal(r.status, 200);
    r = await put({ followUp: { enabled: false, delayHours: 6, mode: 'ai' } });
    assert.equal(r.status, 200);
    const cfg = await BotConfig.findOne({ business: o.business._id });
    assert.equal(cfg.followUp.enabled, false);
    assert.equal(cfg.followUp.template.enabled, true);
    assert.equal(cfg.followUp.template.name, 'seguimiento_venta');
    // Plantilla activa sin nombre: se rechaza.
    r = await put({ followUp: { enabled: false, delayHours: 6, mode: 'ai', template: { enabled: true, name: '', delayHours: 48 } } });
    assert.equal(r.status, 400);
  });

  it('avisa por correo al visitante del chat web solo si ya se fue (una vez)', async () => {
    const { maybeEmailWebVisitor } = await import('../src/services/webVisitor.service.js');
    const { env } = await import('../src/config/env.js');
    const o = await makeOwner('Web');
    const chat = await ChatSimulation.create({
      business: o.business._id,
      channel: 'web',
      customerId: 'sess',
      customerContact: 'visita@test.dev',
      webOrigin: 'mitienda.com',
      webLastSeenAt: new Date(),
      messages: [],
    });
    const prev = env.resend.apiKey;
    env.resend.apiKey = 're_test';
    const realFetch = globalThis.fetch;
    const sent = [];
    globalThis.fetch = async (u, opts) => {
      if (String(u).includes('resend')) {
        sent.push(JSON.parse(opts.body));
        return new Response('{"id":"1"}', { status: 200 });
      }
      return realFetch(u, opts);
    };
    try {
      assert.equal(await maybeEmailWebVisitor({ chat, businessId: o.business._id, text: 'Hola' }), false, 'sigue en el sitio');
      chat.webLastSeenAt = new Date(Date.now() - 5 * 60e3);
      assert.equal(await maybeEmailWebVisitor({ chat, businessId: o.business._id, text: 'Ya tenemos tu pedido' }), true);
      assert.equal(await maybeEmailWebVisitor({ chat, businessId: o.business._id, text: 'Otra' }), false, 'anti-spam');
      assert.equal(sent.length, 1);
      assert.deepEqual([].concat(sent[0].to), ['visita@test.dev']);
      assert.match(sent[0].html, /mitienda\.com/);
    } finally {
      globalThis.fetch = realFetch;
      env.resend.apiKey = prev;
    }
  });
});
