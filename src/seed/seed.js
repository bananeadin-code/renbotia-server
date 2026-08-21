/**
 * Seed de datos demo. Puebla:
 *  - los 3 planes del catálogo
 *  - un usuario admin
 *  - 3 negocios cliente con distintos planes, BotConfig, consumo y un chat demo
 *
 * Uso:  npm run seed
 * OJO: limpia las colecciones antes de sembrar (idempotente en local).
 */
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { PLANS, ROLES } from '../config/constants.js';
import { addMonths } from '../utils/dates.js';

import { User } from '../models/User.js';
import { Plan } from '../models/Plan.js';
import { Business } from '../models/Business.js';
import { Subscription } from '../models/Subscription.js';
import { BotConfig } from '../models/BotConfig.js';
import { UsageLog } from '../models/UsageLog.js';
import { ChatSimulation } from '../models/ChatSimulation.js';
import { ManagementConfig } from '../models/ManagementConfig.js';
import { ManagedRecord } from '../models/ManagedRecord.js';
import { BillingProfile } from '../models/BillingProfile.js';
import { DEFAULT_MANAGEMENT_CONFIG } from '../config/constants.js';

const DEMO_PASSWORD = 'password123';

const DEMO_BUSINESSES = [
  {
    userName: 'Despacho Legal Durango',
    email: 'legal@demo.com',
    businessName: 'Bufete Herrera & Asociados',
    industry: 'legal',
    whatsappNumber: '+52 618 111 1111',
    planKey: 'elite',
    tone: 'formal',
    botName: 'Lic. Bot',
    systemPrompt:
      'Eres el asistente virtual de un despacho de abogados. Responde con precisión y profesionalismo, sin dar asesoría legal vinculante y sugiriendo agendar una consulta cuando el caso lo amerite.',
    faqs: [
      { question: '¿Cuánto cuesta una consulta?', answer: 'La primera consulta tiene un costo de $500 MXN, deducible si contratas nuestros servicios.' },
      { question: '¿Qué áreas manejan?', answer: 'Derecho civil, mercantil, laboral y familiar.' },
      { question: '¿Dónde están ubicados?', answer: 'En el centro de Durango, Calle Constitución 123.' },
    ],
    businessInfo: {
      hours: 'Lunes a viernes de 9:00 a 18:00',
      location: 'Calle Constitución 123, Centro, Durango',
      services: ['Derecho civil', 'Derecho mercantil', 'Derecho laboral', 'Derecho familiar'],
      basePricing: 'Consulta inicial $500 MXN',
    },
    usedTokens: 320_000,
    // Módulo de Gestión (Elite): agenda de consultas legales.
    management: {
      enabledTypes: ['cita', 'prospecto'],
      slotMinutes: 60,
      capacityPerSlot: 1,
      leadTimeHours: 2,
      horizonDays: 30,
      instructions:
        'Agenda consultas de 1 hora. Confirma el área legal del caso y pide el nombre completo del cliente.',
    },
  },
  {
    userName: 'Contadora Martínez',
    email: 'contable@demo.com',
    businessName: 'Contadores Fiscales MX',
    industry: 'contable',
    whatsappNumber: '+52 618 222 2222',
    planKey: 'pro',
    tone: 'cercano',
    botName: 'ContaBot',
    systemPrompt:
      'Eres el asistente de un despacho contable. Ayuda con dudas fiscales generales de forma clara y amable, e invita a agendar una cita para temas específicos.',
    faqs: [
      { question: '¿Hacen declaraciones anuales?', answer: '¡Claro! Personas físicas y morales. Escríbenos para cotizar.' },
      { question: '¿Manejan facturación electrónica?', answer: 'Sí, ofrecemos timbrado y emisión de CFDI 4.0.' },
    ],
    businessInfo: {
      hours: 'Lunes a viernes de 8:00 a 16:00',
      location: 'Av. 20 de Noviembre 456, Durango',
      services: ['Declaraciones', 'Facturación CFDI', 'Nómina', 'Asesoría fiscal'],
      basePricing: 'Declaración anual desde $1,200 MXN',
    },
    usedTokens: 145_000,
  },
  {
    userName: 'Agencia Creativa Nova',
    email: 'agencia@demo.com',
    businessName: 'Nova Marketing',
    industry: 'agencia',
    whatsappNumber: '+52 618 333 3333',
    planKey: 'free',
    tone: 'cercano',
    botName: 'NovaBot',
    systemPrompt:
      'Eres el asistente de una agencia de marketing digital. Responde con energía y creatividad, resaltando resultados y ofreciendo agendar una llamada de diagnóstico gratis.',
    faqs: [
      { question: '¿Qué servicios ofrecen?', answer: 'Redes sociales, campañas de anuncios, diseño y desarrollo web.' },
      { question: '¿Tienen paquetes mensuales?', answer: 'Sí, desde $4,999 MXN al mes. Agenda una llamada para armar el tuyo.' },
    ],
    businessInfo: {
      hours: 'Lunes a viernes de 10:00 a 19:00',
      location: 'Remoto / Durango',
      services: ['Redes sociales', 'Ads', 'Diseño', 'Desarrollo web'],
      basePricing: 'Paquetes desde $4,999 MXN/mes',
    },
    usedTokens: 6_200,
  },
];

/**
 * Devuelve un Date local a `addDays` de `base`, a la hora `hour:00`, ajustado
 * para caer en día hábil (lun–vie) — así coincide con el horario del seed y el
 * motor de disponibilidad lo considera un espacio válido.
 */
function weekdayAt(base, addDays, hour) {
  const d = new Date(base);
  d.setDate(d.getDate() + addDays);
  const dir = addDays < 0 ? -1 : 1;
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + dir);
  d.setHours(hour, 0, 0, 0);
  return d;
}

async function run() {
  await mongoose.connect(env.mongoUri);
  logger.info('Conectado a MongoDB para seed');

  // Limpieza
  await Promise.all([
    User.deleteMany({}),
    Plan.deleteMany({}),
    Business.deleteMany({}),
    Subscription.deleteMany({}),
    BotConfig.deleteMany({}),
    UsageLog.deleteMany({}),
    ChatSimulation.deleteMany({}),
    ManagementConfig.deleteMany({}),
    ManagedRecord.deleteMany({}),
    BillingProfile.deleteMany({}),
  ]);
  logger.info('Colecciones limpiadas');

  // Planes
  const plans = await Plan.insertMany(PLANS);
  const planByKey = new Map(plans.map((p) => [p.key, p]));
  logger.info(`Planes creados: ${plans.map((p) => p.key).join(', ')}`);

  // Admin
  const admin = new User({
    name: 'Admin',
    email: 'admin@demo.com',
    role: ROLES.ADMIN,
    emailVerified: true,
    twoFactorEnabled: false, // demo local sin fricción de código
  });
  await admin.setPassword(DEMO_PASSWORD);
  await admin.save();
  logger.info('Usuario admin creado: admin@demo.com');

  const now = new Date();

  // El admin también tiene su propio negocio en plan Free (no se le obliga a
  // hacer onboarding): entra directo al panel, con el módulo Admin y las demás
  // funciones disponibles de forma opcional.
  const adminBusiness = await Business.create({
    owner: admin._id,
    name: 'RenBotIA (Administración)',
    industry: 'otro',
    whatsappNumber: '',
    status: 'activo',
  });
  await Subscription.create({
    business: adminBusiness._id,
    plan: planByKey.get('free')._id,
    currentPeriodStart: now,
    renewalDate: addMonths(now, 1),
    tokensUsedThisPeriod: 0,
    extraTokens: 0,
  });
  await BotConfig.create({
    business: adminBusiness._id,
    botName: 'Asistente',
    tone: 'neutral',
    faqs: [],
    businessInfo: {},
  });

  // Negocios demo
  for (const demo of DEMO_BUSINESSES) {
    const user = new User({
      name: demo.userName,
      email: demo.email,
      role: ROLES.CLIENTE,
      emailVerified: true,
      twoFactorEnabled: false, // demo local sin fricción de código
    });
    await user.setPassword(DEMO_PASSWORD);
    await user.save();

    const business = await Business.create({
      owner: user._id,
      name: demo.businessName,
      industry: demo.industry,
      whatsappNumber: demo.whatsappNumber,
      status: 'activo',
    });

    const plan = planByKey.get(demo.planKey);
    await Subscription.create({
      business: business._id,
      plan: plan._id,
      currentPeriodStart: now,
      renewalDate: addMonths(now, 1),
      tokensUsedThisPeriod: demo.usedTokens,
      extraTokens: 0,
    });

    await BotConfig.create({
      business: business._id,
      botName: demo.botName,
      tone: demo.tone,
      systemPrompt: demo.systemPrompt,
      faqs: demo.faqs,
      businessInfo: demo.businessInfo,
    });

    // Consumo repartido en los últimos 7 días (para la gráfica del dashboard)
    const logs = [];
    let remaining = demo.usedTokens;
    for (let i = 6; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const chunk = i === 0 ? remaining : Math.round(demo.usedTokens / 8);
      remaining -= chunk;
      const output = Math.round(chunk * 0.35);
      logs.push({
        business: business._id,
        date,
        inputTokens: chunk - output,
        outputTokens: output,
        totalTokens: chunk,
        source: 'simulator',
        simulated: true, // consumo DEMO: no cuenta como gasto real de la API
      });
    }
    await UsageLog.insertMany(logs);

    // Un chat demo
    await ChatSimulation.create({
      business: business._id,
      title: 'Prueba inicial',
      messages: [
        { role: 'user', content: 'Hola, ¿qué servicios ofrecen?', tokens: 20 },
        { role: 'assistant', content: demo.faqs[0]?.answer || '¡Con gusto te ayudo!', tokens: 60 },
      ],
    });

    // Módulo de Gestión (solo el negocio Elite lo trae activo).
    if (demo.management) {
      await ManagementConfig.create({
        business: business._id,
        ...DEFAULT_MANAGEMENT_CONFIG,
        enabled: true,
        ...demo.management,
      });

      const at = (addDays, hour) => weekdayAt(now, addDays, hour);
      await ManagedRecord.insertMany([
        {
          business: business._id,
          type: 'cita',
          status: 'confirmado',
          customer: { name: 'María López', contact: '+52 618 555 0001' },
          scheduledAt: at(1, 10),
          summary: 'Consulta — Derecho familiar',
          notes: 'Divorcio de mutuo consentimiento.',
          source: 'bot',
        },
        {
          business: business._id,
          type: 'cita',
          status: 'pendiente',
          customer: { name: 'Jorge Ramírez', contact: '+52 618 555 0002' },
          scheduledAt: at(2, 12),
          summary: 'Consulta — Derecho mercantil',
          source: 'bot',
        },
        {
          business: business._id,
          type: 'cita',
          status: 'confirmado',
          customer: { name: 'Empresa Aceros del Norte', contact: 'contacto@aceros.mx' },
          scheduledAt: at(3, 16),
          summary: 'Consulta — Contrato laboral',
          source: 'manual',
        },
        {
          business: business._id,
          type: 'cita',
          status: 'completado',
          customer: { name: 'Ana Torres', contact: '+52 618 555 0003' },
          scheduledAt: weekdayAt(now, -3, 11),
          summary: 'Consulta — Derecho civil',
          source: 'bot',
        },
        {
          business: business._id,
          type: 'prospecto',
          status: 'pendiente',
          customer: { name: 'Luis Fernández', contact: '+52 618 555 0004' },
          summary: 'Interesado en asesoría fiscal continua',
          notes: 'Pidió cotización mensual. Dar seguimiento.',
          source: 'bot',
        },
      ]);
    }

    logger.info(`Negocio demo creado: ${demo.businessName} (${demo.planKey})`);
  }

  logger.info('\n=== Seed completado ===');
  logger.info('Credenciales demo (password para todas: ' + DEMO_PASSWORD + '):');
  logger.info('  admin@demo.com     (admin)');
  DEMO_BUSINESSES.forEach((d) => logger.info(`  ${d.email}   (${d.planKey})`));

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  logger.error(`Error en seed: ${err.stack || err.message}`);
  process.exit(1);
});
