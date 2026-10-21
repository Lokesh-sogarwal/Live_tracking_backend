import { Role, RolePermission } from '../models/index.js';

// Canonical roles. Comparisons always use the lowercase key, never the display name,
// which fixes the legacy "Admin" vs "admin" vs "driver" mismatches.
export const DEFAULT_ROLES = [
  { roleId: 1, key: 'superadmin', name: 'Superadmin' },
  { roleId: 2, key: 'admin', name: 'Admin' },
  { roleId: 3, key: 'operator', name: 'Operator' },
  { roleId: 4, key: 'driver', name: 'Driver' },
  { roleId: 5, key: 'passenger', name: 'Passenger' },
];

const RANK = { superadmin: 4, admin: 3, operator: 2, driver: 1, passenger: 0 };

export const normalizeRole = (role) => (role || '').toString().trim().toLowerCase().replace(/[\s_-]+/g, '');

export const roleRank = (key) => RANK[normalizeRole(key)] ?? 0;

export const roleDisplayName = (key) =>
  DEFAULT_ROLES.find((r) => r.key === normalizeRole(key))?.name ?? (key || null);

export const isAdminRole = (key) => ['superadmin', 'admin'].includes(normalizeRole(key));

// Which roles a requester may assign when creating a user. Unauthenticated signup
// may only ever produce a passenger.
export function assignableRoles(requesterRoleKey) {
  const r = normalizeRole(requesterRoleKey);
  if (r === 'superadmin') return DEFAULT_ROLES.map((x) => x.key);
  if (r === 'admin') return ['admin', 'operator', 'driver', 'passenger'];
  return ['passenger'];
}

export async function ensureDefaultRoles() {
  for (const role of DEFAULT_ROLES) {
    await Role.updateOne({ key: role.key }, { $setOnInsert: role }, { upsert: true });
  }
}

// Server-side port of the React app's legacyAllows() (src/utils/legacyAccess.js):
// the default when no explicit role_permissions row exists.
const LEGACY_DENY = {
  operator: new Set(['active_users', 'users']),
  driver: new Set(['active_users', 'users', 'create_routes', 'live_tracking', 'Uploded_documents', 'Feedbacks']),
  passenger: new Set(['active_users', 'users', 'create_routes', 'bus_schedule', 'drivers', 'Uploded_documents', 'Feedbacks']),
};

export function legacyAllows(roleKey, featureKey) {
  const r = normalizeRole(roleKey);
  if (!featureKey) return true;
  if (r === 'superadmin') return true;
  if (featureKey === 'permissions') return false;
  const deny = LEGACY_DENY[r];
  if (deny) return !deny.has(featureKey);
  // Admin and unknown roles default to allow, mirroring the frontend.
  return r === 'admin';
}

// Short-lived in-process cache so permission checks do not hit Mongo on every request.
let cache = { at: 0, map: new Map() };
const CACHE_MS = 5000;

export function invalidatePermissionCache() {
  cache = { at: 0, map: new Map() };
}

async function explicitPermissions() {
  if (Date.now() - cache.at < CACHE_MS) return cache.map;
  const rows = await RolePermission.find({}, { roleKey: 1, featureKey: 1, allowed: 1 }).lean();
  const map = new Map();
  for (const row of rows) map.set(`${row.roleKey}:${row.featureKey}`, row.allowed);
  cache = { at: Date.now(), map };
  return map;
}

export async function can(roleKey, featureKey) {
  const r = normalizeRole(roleKey);
  if (r === 'superadmin') return true;
  const explicit = (await explicitPermissions()).get(`${r}:${featureKey}`);
  return explicit === undefined ? legacyAllows(r, featureKey) : explicit;
}

// Feature keys rendered by the Permissions screen (Permissions.jsx FEATURES).
export const FEATURE_KEYS = [
  'dashboard', 'profile', 'users', 'active_users', 'drivers', 'upload', 'live_tracking',
  'create_routes', 'all_routes', 'bus_tracking', 'bus_schedule', 'Uploded_documents',
  'Feedback', 'Feedbacks', 'chat_bot', 'chat', 'profile_settings', 'edit_profile',
  'register_bus', 'notifications', 'permissions',
];

export async function effectivePermissions(roleKey) {
  const out = {};
  for (const key of FEATURE_KEYS) out[key] = await can(roleKey, key);
  return out;
}
