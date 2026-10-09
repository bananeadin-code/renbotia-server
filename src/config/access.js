/**
 * IAM ligero (Fase 3): qué puede hacer cada persona del equipo.
 *
 *  - Módulos con nivel: 'none' (no lo ve), 'view' (lo ve, no cambia nada) o
 *    'edit' (lo usa y lo cambia).
 *  - Canales: 'all' o una lista (whatsapp, facebook, instagram, web) para limitar
 *    qué conversaciones ve y atiende (p. ej. un agente solo de Instagram).
 *  - Roles listos (Administrador, Agente de ventas, Solo lectura), roles
 *    personalizados del negocio y acceso "Personalizado" por persona.
 *
 * El DUEÑO siempre tiene todo. Facturación, seguridad del equipo y el control
 * por WhatsApp son SOLO del dueño (no se pueden delegar).
 */

export const MODULES = [
  'conversations', // bandeja: ver / responder, tomar el control, etiquetas, bloquear
  'training', // entrenamiento del bot, avisos, aprende de ti, importar
  'simulator', // usar el simulador (gasta créditos)
  'management', // gestión de trabajo: citas, pedidos, prospectos (Elite)
  'analytics', // analíticas detalladas
  'connections', // conexiones: WhatsApp, Messenger, Instagram, chat del sitio
  'profile', // datos del negocio
  'team', // equipo: ver miembros / invitar, quitar, asignar roles
  'activity', // bitácora de actividad
];

export const CHANNELS = ['whatsapp', 'facebook', 'instagram', 'web'];

// Niveles posibles por módulo (algunos no tienen "editar" o "solo ver").
export const MODULE_LEVELS = {
  conversations: ['none', 'view', 'edit'],
  training: ['none', 'view', 'edit'],
  simulator: ['none', 'edit'],
  management: ['none', 'view', 'edit'],
  analytics: ['none', 'view'],
  connections: ['none', 'view', 'edit'],
  profile: ['none', 'view', 'edit'],
  team: ['none', 'view', 'edit'],
  activity: ['none', 'view'],
};

const RANK = { none: 0, view: 1, edit: 2 };

export const PRESET_ROLES = {
  admin: {
    name: 'Administrador',
    description: 'Todo, salvo facturación y la seguridad del equipo.',
    modules: {
      conversations: 'edit',
      training: 'edit',
      simulator: 'edit',
      management: 'edit',
      analytics: 'view',
      connections: 'edit',
      profile: 'edit',
      team: 'edit',
      activity: 'view',
    },
    channels: 'all',
  },
  agent: {
    name: 'Agente de ventas',
    description: 'Atiende conversaciones y la agenda; ve el entrenamiento sin cambiarlo.',
    modules: {
      conversations: 'edit',
      training: 'view',
      simulator: 'edit',
      management: 'edit',
      analytics: 'none',
      connections: 'none',
      profile: 'view',
      team: 'none',
      activity: 'none',
    },
    channels: 'all',
  },
  readonly: {
    name: 'Solo lectura',
    description: 'Ve todo (ideal para tu contador o socio), sin cambiar nada.',
    modules: {
      conversations: 'view',
      training: 'view',
      simulator: 'none',
      management: 'view',
      analytics: 'view',
      connections: 'view',
      profile: 'view',
      team: 'view',
      activity: 'view',
    },
    channels: 'all',
  },
};

export const OWNER_ACCESS = {
  roleKey: 'owner',
  roleName: 'Dueño',
  modules: Object.fromEntries(MODULES.map((m) => [m, MODULE_LEVELS[m].includes('edit') ? 'edit' : 'view'])),
  channels: 'all',
};

/** Ajusta un nivel a los permitidos por el módulo (p. ej. analíticas no tiene "editar"). */
function clampLevel(module, level) {
  const allowed = MODULE_LEVELS[module] || ['none'];
  if (allowed.includes(level)) return level;
  // Se baja al máximo permitido sin pasarse (edit → view si no hay edit).
  const r = RANK[level] ?? 0;
  return [...allowed].reverse().find((l) => RANK[l] <= r) || 'none';
}

/** Normaliza un mapa de módulos (rellena faltantes con 'none'). */
export function normalizeModules(modules = {}) {
  return Object.fromEntries(MODULES.map((m) => [m, clampLevel(m, modules?.[m] || 'none')]));
}

export function normalizeChannels(channels) {
  if (!channels || channels === 'all') return 'all';
  const list = [...new Set((Array.isArray(channels) ? channels : []).filter((c) => CHANNELS.includes(c)))];
  return list.length === CHANNELS.length ? 'all' : list;
}

/**
 * Permisos de antes de la Fase 3 (4 interruptores) → acceso equivalente. Así
 * nadie pierde ni gana nada al migrar.
 */
export function legacyAccess(perms = {}) {
  const p = { simulator: true, training: true, profile: false, connections: false, ...perms };
  return {
    roleKey: 'custom',
    roleName: 'Personalizado',
    modules: normalizeModules({
      conversations: 'edit',
      training: p.training ? 'edit' : 'view',
      simulator: p.simulator ? 'edit' : 'none',
      management: 'edit',
      analytics: 'view',
      connections: p.connections ? 'edit' : 'view',
      profile: p.profile ? 'edit' : 'view',
      team: 'view',
      activity: 'view',
    }),
    channels: 'all',
  };
}

/**
 * Acceso efectivo de una membresía.
 * @param {object} membership  { role, roleKey?, access?, permissions? }
 * @param {object} business    { customRoles? }
 */
export function resolveAccess(membership, business) {
  if (!membership) return null;
  if (membership.role === 'owner') return OWNER_ACCESS;
  const key = membership.roleKey || '';
  if (PRESET_ROLES[key]) {
    const r = PRESET_ROLES[key];
    return { roleKey: key, roleName: r.name, modules: normalizeModules(r.modules), channels: normalizeChannels(r.channels) };
  }
  if (key.startsWith('role:')) {
    const id = key.slice(5);
    const r = (business?.customRoles || []).find((x) => String(x._id) === id);
    if (r) return { roleKey: key, roleName: r.name, modules: normalizeModules(r.modules), channels: normalizeChannels(r.channels) };
    // El rol se borró: lo más seguro es solo lectura.
    const ro = PRESET_ROLES.readonly;
    return { roleKey: 'readonly', roleName: ro.name, modules: normalizeModules(ro.modules), channels: 'all' };
  }
  if (key === 'custom' && membership.access?.modules) {
    return {
      roleKey: 'custom',
      roleName: 'Personalizado',
      modules: normalizeModules(membership.access.modules),
      channels: normalizeChannels(membership.access.channels),
    };
  }
  return legacyAccess(membership.permissions);
}

/** ¿El acceso alcanza el nivel pedido en el módulo? */
export function can(access, module, level = 'view') {
  if (!access) return false;
  return (RANK[access.modules?.[module]] ?? 0) >= (RANK[level] ?? 1);
}

/** ¿Puede ver/atender conversaciones de este canal? */
export function canChannel(access, channel) {
  if (!access) return false;
  if (channel === 'simulator') return can(access, 'simulator', 'edit');
  return access.channels === 'all' || (access.channels || []).includes(channel);
}

/** Forma "vieja" de permisos (4 claves) para el código y el cliente existentes. */
export function legacyPermissionsOf(access) {
  return {
    simulator: can(access, 'simulator', 'edit'),
    training: can(access, 'training', 'edit'),
    profile: can(access, 'profile', 'edit'),
    connections: can(access, 'connections', 'edit'),
  };
}
