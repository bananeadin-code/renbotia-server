// Asistente del dueño por WhatsApp: memoria, estado real, acciones y confirmaciones.
import { setupDb, teardownDb, makeOwner } from './helpers.mjs';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

describe('Asistente del dueño por WhatsApp', () => {
  let Business, Plan, Subscription, ChatSimulation, ManagedRecord, OwnerMessage, svc;
  const WA = '5216181234567';
  let sent = [];
  let script = []; // respuestas simuladas de la IA, en orden
  let lastCall = null;

  // IA simulada: ejecuta las herramientas que pide el "guion" y devuelve su texto.
  async function fakeAi({ system, messages, executeTool }) {
    lastCall = { system, messages };
    const step = script.shift() || { text: 'ok' };
    for (const [name, input] of step.tools || []) await executeTool(name, input);
    return { text: step.text ?? '', inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 20, billableTokens: 20 };
  }

  before(async () => {
    await setupDb();
    ({ Business } = await import('../src/models/Business.js'));
    ({ Plan } = await import('../src/models/Plan.js'));
    ({ Subscription } = await import('../src/models/Subscription.js'));
    ({ ChatSimulation } = await import('../src/models/ChatSimulation.js'));
    ({ ManagedRecord } = await import('../src/models/ManagedRecord.js'));
    ({ OwnerMessage } = await import('../src/models/OwnerMessage.js'));
    svc = await import('../src/services/ownerControl.service.js');
    svc.__setOwnerTestHooks({ send: async ({ text }) => sent.push(text), ai: fakeAi });
  });
  after(async () => {
    svc.__setOwnerTestHooks(null);
    await teardownDb();
  });
  beforeEach(() => {
    sent = [];
    script = [];
    lastCall = null;
  });

  async function ownerBiz(plan = 'elite') {
    const o = await makeOwner('Dueno');
    const p = await Plan.findOne({ key: plan });
    await Subscription.updateOne({ business: o.business._id }, { $set: { plan: p._id } });
    await Business.updateOne({ _id: o.business._id }, { $set: { ownerWhatsApp: [{ waId: WA, linkedAt: new Date(), lastUsedAt: new Date() }] } });
    return Business.findById(o.business._id);
  }
  const send = (business, body) => svc.handleOwnerMessage({ business, waId: WA, msg: { type: 'text', text: { body } }, phoneNumberId: 'P1' });
  const paused = async (id) => (await Business.findById(id).lean()).channelSettings;

  it('pausar pide SÍ, recuerda la charla ("en todos") y el SÍ lo aplica', async () => {
    const b = await ownerBiz();
    script = [{ text: '¿En qué canal? WhatsApp, Messenger, Instagram o todos.' }];
    await send(b, 'Pausa el bot hasta las 6 de la tarde');
    script = [{ tools: [['pausar_bot', { canal: 'todos', hasta: '18:00' }]], text: '' }];
    await send(b, 'En todos');
    // La IA recibió la charla anterior: entiende "en todos" en contexto.
    assert.ok(lastCall.messages.length >= 3, 'historial incluido');
    assert.match(lastCall.messages[0].content, /Pausa el bot/);
    assert.match(sent.at(-1), /\*SÍ\*/, 'siempre termina pidiendo el SÍ');
    assert.equal((await paused(b._id)).whatsapp.paused, false, 'aún no se aplica');

    await send(b, 'SÍ');
    const cs = await paused(b._id);
    assert.equal(cs.whatsapp.paused, true);
    assert.equal(cs.facebook.paused, true);
    assert.equal(cs.instagram.paused, true);
    assert.equal(cs.web.paused, true, '"todos" incluye el chat del sitio web');
    assert.ok(cs.whatsapp.pausedUntil, 'con hora de reactivación');
    assert.match(sent.at(-1), /en pausa/);
  });

  it('reanudar se aplica al momento y nunca contesta "(sin respuesta)"', async () => {
    const b = await ownerBiz();
    await Business.updateOne({ _id: b._id }, { $set: { 'channelSettings.whatsapp.paused': true, 'channelSettings.instagram.paused': true } });
    script = [{ tools: [['reanudar_bot', { canal: 'todos' }]], text: '(sin respuesta)' }];
    await send(b, 'Reanudar el bot en todos los canales');
    const cs = await paused(b._id);
    assert.equal(cs.whatsapp.paused, false);
    assert.equal(cs.instagram.paused, false);
    assert.doesNotMatch(sent.at(-1), /sin respuesta/);
    assert.match(sent.at(-1), /respondiendo/);
  });

  it('sabe si el bot está pausado (estado real en el contexto y en ver_estado)', async () => {
    const b = await ownerBiz();
    await Business.updateOne({ _id: b._id }, { $set: { 'channelSettings.facebook.paused': true } });
    let state;
    script = [{ text: 'Messenger está en pausa.' }];
    await send(b, '¿El bot está pausado?');
    assert.match(lastCall.system, /Messenger en pausa/);
    const fresh = await Business.findById(b._id);
    state = await svc.runOwnerTool('ver_estado', {}, { business: fresh, waId: WA, tz: 'America/Mexico_City', sub: await Subscription.findOne({ business: b._id }).populate('plan'), notes: [] });
    const fb = state.canales.find((c) => c.canal === 'Messenger');
    assert.match(fb.bot, /en pausa/);
    assert.equal(state.canales.find((c) => c.canal === 'WhatsApp').bot, 'activo');
  });

  it('un SÍ fuera de tiempo avisa que venció en vez de "no hay nada pendiente"', async () => {
    const b = await ownerBiz();
    await Business.updateOne(
      { _id: b._id },
      { $set: { ownerPending: { action: 'pausar_bot', args: { canal: 'todos', until: null }, summary: 'Pausar', waId: WA, expiresAt: new Date(Date.now() - 1000) } } }
    );
    await send(b, 'Sí');
    assert.match(sent.at(-1), /venció/);
    assert.equal((await paused(b._id)).whatsapp.paused, false, 'no aplica una confirmación vencida');
  });

  it('una respuesta que no es sí/no no borra lo pendiente: la IA decide (confirmar con otras palabras)', async () => {
    const b = await ownerBiz();
    script = [{ tools: [['agregar_aviso', { texto: 'Hoy cerramos a las 4', vigencia: 'hoy' }]], text: 'Agrego el aviso. Responde *SÍ*.' }];
    await send(b, 'Avisa que hoy cerramos a las 4');
    script = [{ tools: [['confirmar_accion', {}]], text: '' }];
    await send(b, 'Sí, adelante con eso por favor');
    assert.match(lastCall.system, /Acción pendiente/);
    const { BotConfig } = await import('../src/models/BotConfig.js');
    const cfg = await BotConfig.findOne({ business: b._id }).lean();
    assert.ok(cfg.notices.some((x) => x.text === 'Hoy cerramos a las 4'));
    assert.match(sent.at(-1), /ya lo sabe/);
  });

  it('busca clientes y cambia el estado de la agenda', async () => {
    const b = await ownerBiz('elite');
    await ChatSimulation.create({
      business: b._id,
      channel: 'instagram',
      customerId: 'IG9',
      customerName: 'Laura Méndez',
      needsAttention: true,
      messages: [{ role: 'user', content: 'Quiero un pastel de 3 leches para el sábado' }],
    });
    const ctx = { business: b, waId: WA, tz: 'America/Mexico_City', sub: await Subscription.findOne({ business: b._id }).populate('plan'), notes: [] };
    const r = await svc.runOwnerTool('buscar_cliente', { texto: 'laura' }, ctx);
    assert.equal(r.resultados[0].canal, 'Instagram');
    assert.equal(r.resultados[0].espera_respuesta, true);
    assert.match(r.resultados[0].ultimos_mensajes[0], /3 leches/);

    const rec = await ManagedRecord.create({ business: b._id, type: 'cita', summary: 'Corte', customer: { name: 'Ana' }, scheduledAt: new Date(Date.now() + 3600e3) });
    const ag = await svc.runOwnerTool('ver_agenda', { periodo: 'semana' }, ctx);
    assert.equal(ag.registros[0].id, String(rec._id));
    const ch = await svc.runOwnerTool('cambiar_estado_registro', { id: String(rec._id), estado: 'confirmado' }, ctx);
    assert.equal(ch.ok, true);
    assert.equal((await ManagedRecord.findById(rec._id)).status, 'confirmado');
    // Otro negocio no puede tocar ese registro.
    const other = await ownerBiz('elite');
    const ctx2 = { ...ctx, business: other };
    assert.equal((await svc.runOwnerTool('cambiar_estado_registro', { id: String(rec._id), estado: 'cancelado' }, ctx2)).ok, false);
  });

  it('solo herramientas permitidas; modo cliente/dueño con frases naturales', async () => {
    const b = await ownerBiz();
    const ctx = { business: b, waId: WA, tz: 'America/Mexico_City', sub: null, notes: [] };
    assert.equal((await svc.runOwnerTool('borrar_todo', {}, ctx)).error, 'herramienta no permitida');
    assert.equal(await send(b, 'pasa a modo cliente'), true);
    assert.equal(await send(b, 'hola quiero un pastel'), false, 'en modo cliente lo atiende el bot de clientes');
    assert.equal(await send(b, 'vuelve a modo dueño'), true);
    assert.match(sent.at(-1), /modo dueño/);
    // Un número que no es del dueño no entra aquí.
    assert.equal(await svc.handleOwnerMessage({ business: b, waId: '5210000000000', msg: { type: 'text', text: { body: 'hola' } } }), false);
  });

  it('candado: detecta cuando la IA dice que hizo algo sin usar la herramienta', async () => {
    const no = { used: [], pendingSummary: '' };
    assert.equal(svc.claimsUnbackedAction('Hecho, pausé el bot en Instagram', no), true);
    assert.equal(svc.claimsUnbackedAction('Perfecto, ya quedó confirmado', no), true);
    assert.equal(svc.claimsUnbackedAction('¿Quieres que lo pause?', no), false);
    assert.equal(svc.claimsUnbackedAction('Voy a pausar el bot', no), false);
    assert.equal(svc.claimsUnbackedAction('Listo, reactivé el bot', { used: ['reanudar_bot'], pendingSummary: '' }), false);

    // De punta a punta: la 1a respuesta miente, el sistema la corrige y se aplica de verdad.
    const b = await ownerBiz();
    await Business.updateOne({ _id: b._id }, { $set: { 'channelSettings.whatsapp.paused': true } });
    script = [{ text: 'Listo, reactivé el bot.' }, { tools: [['reanudar_bot', { canal: 'todos' }]], text: 'Listo, reactivé el bot en todos tus canales.' }];
    await send(b, 'reactívalo');
    assert.match(lastCall.messages.at(-1).content, /NADA cambió/);
    assert.equal((await paused(b._id)).whatsapp.paused, false);
  });

  it('composeReply: nunca vacío y siempre pide SÍ si quedó algo pendiente', () => {
    assert.equal(svc.composeReply('(sin respuesta)', { notes: [], pendingSummary: '' }), 'Listo.');
    assert.equal(svc.composeReply('', { notes: ['Listo, quité el aviso.'], pendingSummary: '' }), 'Listo, quité el aviso.');
    assert.match(svc.composeReply('Preparo la pausa.', { notes: [], pendingSummary: 'Pausar el bot' }), /Responde \*SÍ\*/);
    // "sin" ya no cuenta como "sí" (el error que ocultaba la confirmación).
    assert.match(svc.composeReply('(sin respuesta)', { notes: [], pendingSummary: 'Reactivar' }), /\*SÍ\*/);
  });
});
