import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { Session, User } from '../models/index.js';
import { roleDisplayName } from './roles.js';
import { unauthorized } from '../utils/errors.js';

const SESSION_RETENTION_MS = 7 * 24 * 3600 * 1000;

// Issues a JWT bound to a server-side session (jti). The payload keeps the legacy
// claim names the React app decodes: user_id, role, is_password_change.
export async function issueToken(user, config) {
  const jti = randomUUID();
  const token = jwt.sign(
    {
      user_id: user.userId,
      role: roleDisplayName(user.roleKey),
      is_password_change: Boolean(user.isPasswordChange),
      ...(user.mustChangePassword ? { must_change_password: true } : {}),
      fullname: user.fullname,
    },
    config.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: config.JWT_EXPIRES_IN, jwtid: jti, subject: user.userId },
  );
  const { exp } = jwt.decode(token);
  const expiresAt = new Date(exp * 1000);
  await Session.create({
    jti,
    user: user._id,
    userId: user.userId,
    fullname: user.fullname,
    email: user.email,
    roleKey: user.roleKey,
    expiresAt,
    purgeAt: new Date(expiresAt.getTime() + SESSION_RETENTION_MS),
  });
  return { token, jti, expiresAt };
}

// Verifies signature, expiry and that the session has not been revoked (logout).
// Role is read from the database, not the token, so role changes take effect immediately.
export async function authenticateToken(token, config) {
  let payload;
  try {
    payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    throw unauthorized(err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token');
  }
  if (!payload.jti || !payload.user_id) throw unauthorized('Invalid token');

  const session = await Session.findOne({ jti: payload.jti }, { revokedAt: 1, user: 1 }).lean();
  if (!session || session.revokedAt) throw unauthorized('Session has been logged out');

  const user = await User.findById(session.user).lean();
  if (!user || user.userId !== payload.user_id) throw unauthorized('User no longer exists');

  return { user, jti: payload.jti, payload };
}

export async function revokeSession(jti) {
  await Session.updateOne({ jti, revokedAt: null }, { $set: { revokedAt: new Date() } });
}

export function extractBearer(header) {
  if (!header || typeof header !== 'string') return null;
  const [scheme, value] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !value) return null;
  return value.trim();
}
