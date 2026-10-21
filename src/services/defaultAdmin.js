import { User } from '../models/index.js';
import { hashPassword } from './passwords.js';
import { roleDisplayName } from './roles.js';

// Creates the default admin account from DEFAULT_ADMIN_* on startup, once.
// An existing account with that email is never modified: changing the env values later
// does not reset its password or role (change those through the app instead).
// The password is never logged.
export async function ensureDefaultAdmin(config, logger) {
  const email = config.DEFAULT_ADMIN_EMAIL;
  if (!email) return { status: 'not_configured' };

  const existing = await User.findOne({ email }, { roleKey: 1 }).lean();
  if (existing) {
    if (existing.roleKey !== config.DEFAULT_ADMIN_ROLE) {
      logger.warn({ email, role: existing.roleKey }, 'Default admin email belongs to an account with a different role; not modified');
    }
    return { status: 'exists' };
  }

  try {
    await User.create({
      fullname: config.DEFAULT_ADMIN_NAME,
      email,
      passwordHash: await hashPassword(config.DEFAULT_ADMIN_PASSWORD),
      roleKey: config.DEFAULT_ADMIN_ROLE,
      isPasswordChange: true,
    });
  } catch (err) {
    // Another instance created it at the same moment.
    if (err.code === 11000) return { status: 'exists' };
    throw err;
  }
  logger.info({ email, role: roleDisplayName(config.DEFAULT_ADMIN_ROLE) }, 'Default admin account created');
  return { status: 'created' };
}
