import { createHash, randomBytes, randomInt } from 'node:crypto';
import { PasswordReset, Session, User } from '../models/index.js';
import { hashPassword } from './passwords.js';
import { notifyAdmins } from './notifications.js';

const DAY_MS = 24 * 3600 * 1000;
export const MIN_PASSWORD_LENGTH = 8;

export const hashResetToken = (token) => createHash('sha256').update(token).digest('hex');

// 12 characters without look-alikes (0/O, 1/l/I), always containing a digit.
export function generateTemporaryPassword(length = 12) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < length - 1; i++) out += alphabet[randomInt(alphabet.length)];
  return out + '23456789'[randomInt(8)];
}

// Ends every session of the user (all devices), e.g. after a password change or reset.
export async function revokeAllSessions(userObjectId) {
  await Session.updateMany({ user: userObjectId, revokedAt: null }, { $set: { revokedAt: new Date() } });
}

export async function setPassword(user, password, { mustChange }) {
  await User.updateOne(
    { _id: user._id },
    { $set: { passwordHash: await hashPassword(password), mustChangePassword: mustChange, isPasswordChange: !mustChange } },
  );
  await revokeAllSessions(user._id);
}

// Marks open admin-channel requests for this user as handled.
export async function resolveAdminRequests(user, resolvedBy = null) {
  await PasswordReset.updateMany(
    { user: user._id, channel: 'admin', resolvedAt: null },
    { $set: { resolvedAt: new Date(), resolvedBy: resolvedBy?._id ?? null } },
  );
}

// Emails a one-time link. Only the SHA-256 of the token is stored; older unused links die.
export async function sendResetLink(user, { config, mailer }) {
  const token = randomBytes(32).toString('base64url');
  const ttlMs = config.PASSWORD_RESET_TTL_MINUTES * 60_000;
  const expiresAt = new Date(Date.now() + ttlMs);
  await PasswordReset.deleteMany({ user: user._id, channel: 'email', usedAt: null });
  await PasswordReset.create({
    user: user._id,
    channel: 'email',
    tokenHash: hashResetToken(token),
    expiresAt,
    purgeAt: new Date(expiresAt.getTime() + 7 * DAY_MS),
  });
  // The token travels in the URL fragment, so it is not sent to the web server serving the app.
  const link = `${config.appPublicUrl}/reset-password#token=${token}`;
  const minutes = config.PASSWORD_RESET_TTL_MINUTES;
  await mailer.send({
    to: user.email,
    subject: 'Reset your Live Tracking password',
    text:
      `Hello ${user.fullname},\n\n` +
      `Someone asked to reset the password for your Live Tracking account. ` +
      `Open this link within ${minutes} minutes to choose a new password:\n\n${link}\n\n` +
      `If you did not ask for this, ignore this email; your password stays the same.\n`,
  });
}

// Without email, the request is queued for administrators (one open request per user).
export async function requestAdminReset(user, { config, logger }) {
  const open = await PasswordReset.exists({ user: user._id, channel: 'admin', resolvedAt: null });
  if (open) return;
  await PasswordReset.create({ user: user._id, channel: 'admin', purgeAt: new Date(Date.now() + 30 * DAY_MS) });
  await notifyAdmins(`Password reset requested by ${user.fullname} (${user.email})`, 'password_reset', {
    tz: config.APP_TIMEZONE,
    logger,
  });
}
