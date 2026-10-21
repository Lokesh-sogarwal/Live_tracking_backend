import { z } from 'zod';
import { Role, RolePermission } from '../models/index.js';
import {
  effectivePermissions, invalidatePermissionCache, normalizeRole, roleDisplayName,
} from '../services/roles.js';

export const schemas = {
  matrixUpdate: z.object({
    updates: z
      .array(
        z.object({
          role_name: z.string().trim().min(1).max(50),
          feature_key: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_]+$/, 'Invalid feature_key'),
          allowed: z.boolean(),
        }),
      )
      .min(1, 'updates must be a non-empty list')
      .max(500),
  }),
};

export function createPermissionsController() {
  return {
    async roles(_req, res) {
      const roles = await Role.find().sort({ name: 1 }).lean();
      res.json(roles.map((r) => ({ role_id: r.roleId, role_name: r.name })));
    },

    // Explicit settings only; the UI treats missing keys as "use default".
    async matrix(_req, res) {
      const [roles, perms] = await Promise.all([Role.find().sort({ roleId: 1 }).lean(), RolePermission.find().lean()]);
      const matrix = Object.fromEntries(roles.map((r) => [r.name, {}]));
      const nameByKey = new Map(roles.map((r) => [r.key, r.name]));
      for (const p of perms) {
        const name = nameByKey.get(p.roleKey);
        if (name) matrix[name][p.featureKey] = Boolean(p.allowed);
      }
      res.json({ roles: roles.map((r) => r.name), matrix });
    },

    async updateMatrix(req, res) {
      const roles = await Role.find().lean();
      const keys = new Set(roles.map((r) => r.key));
      const skipped = [];
      const ops = [];
      for (const u of req.body.updates) {
        const roleKey = normalizeRole(u.role_name);
        if (!keys.has(roleKey)) {
          skipped.push(u.role_name);
          continue;
        }
        ops.push({
          updateOne: {
            filter: { roleKey, featureKey: u.feature_key },
            update: { $set: { allowed: u.allowed } },
            upsert: true,
          },
        });
      }
      if (ops.length) await RolePermission.bulkWrite(ops, { ordered: false });
      invalidatePermissionCache();
      res.json({ message: 'Permissions updated', applied: ops.length, skipped_roles: [...new Set(skipped)] });
    },

    // Effective permissions (explicit rows + defaults) for every feature the UI gates, so
    // the menu hides what the server would refuse.
    async my(req, res) {
      res.json({ role: roleDisplayName(req.roleKey), permissions: await effectivePermissions(req.roleKey) });
    },
  };
}
