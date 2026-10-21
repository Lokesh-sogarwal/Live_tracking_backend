import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { EmailVerification } from '../models/index.js';
import { AppError, badRequest } from '../utils/errors.js';

const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60_000;
const MAX_SENDS_PER_HOUR = 5;
const TICKET_MINUTES = 30;

const tooMany = (message) => new AppError(429, 'RATE_LIMITED', message);
const hashCode = (config, email, code) => createHmac('sha256', config.JWT_SECRET).update(`signup-code:${email}:${code}`).digest('hex');

// Sends a 6-digit code to the address. One open challenge per email; a resend replaces the
// code, honours a cooldown and an hourly cap, and resets the attempt counter.
export async function sendSignupCode(email, { config, mailer }) {
  const now = Date.now();
  const ttlMs = config.SIGNUP_CODE_TTL_MINUTES * 60_000;
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const existing = await EmailVerification.findOne({ email, verifiedAt: null }).sort({ createdAt: -1 });

  if (existing) {
    if (now - existing.lastSentAt.getTime() < RESEND_COOLDOWN_MS) {
      throw tooMany('Wait a minute before asking for another code');
    }
    const inWindow = now - existing.windowStartedAt.getTime() < 3600_000;
    if (inWindow && existing.sendCount >= MAX_SENDS_PER_HOUR) throw tooMany('Too many codes requested. Try again in an hour.');
    existing.codeHash = hashCode(config, email, code);
    existing.expiresAt = new Date(now + ttlMs);
    existing.attempts = 0;
    existing.sendCount = inWindow ? existing.sendCount + 1 : 1;
    if (!inWindow) existing.windowStartedAt = new Date(now);
    existing.lastSentAt = new Date(now);
    existing.purgeAt = new Date(now + 24 * 3600_000);
    await existing.save();
  } else {
    await EmailVerification.create({
      email,
      codeHash: hashCode(config, email, code),
      expiresAt: new Date(now + ttlMs),
      purgeAt: new Date(now + 24 * 3600_000),
    });
  }

  await mailer.send({
    to: email,
    subject: `${code} is your Live Tracking verification code`,
    text:
      `Your Live Tracking verification code is ${code}.\n\n` +
      `It expires in ${config.SIGNUP_CODE_TTL_MINUTES} minutes. If you did not try to create an account, ignore this email.\n`,
  });
}

// Checks a code and returns a short-lived signed ticket proving the email was verified.
export async function verifySignupCode(email, code, { config }) {
  const challenge = await EmailVerification.findOne({ email, verifiedAt: null }).sort({ createdAt: -1 });
  const invalid = () => badRequest('That code is not right. Check the email and try again.');
  if (!challenge) throw badRequest('Ask for a verification code first');
  if (challenge.expiresAt.getTime() < Date.now()) throw badRequest('This code has expired. Ask for a new one.');
  if (challenge.attempts >= MAX_ATTEMPTS) throw tooMany('Too many wrong codes. Ask for a new one.');

  const expected = Buffer.from(challenge.codeHash, 'hex');
  const given = Buffer.from(hashCode(config, email, String(code)), 'hex');
  if (!timingSafeEqual(expected, given)) {
    await EmailVerification.updateOne({ _id: challenge._id }, { $inc: { attempts: 1 } });
    throw invalid();
  }
  // Atomic: a code verifies once.
  const won = await EmailVerification.findOneAndUpdate(
    { _id: challenge._id, verifiedAt: null },
    { $set: { verifiedAt: new Date() } },
  );
  if (!won) throw invalid();

  const ticket = jwt.sign({ typ: 'email_verified', email, vid: String(challenge._id) }, config.JWT_SECRET, {
    algorithm: 'HS256',
    audience: 'signup',
    expiresIn: `${TICKET_MINUTES}m`,
  });
  return { ticket, expiresInMinutes: TICKET_MINUTES };
}

// Validates a ticket for this email and marks it used (single use). Returns the verified time.
export async function consumeVerificationTicket(ticket, email, { config }) {
  const fail = () => badRequest('Your email verification has expired. Verify your email again.');
  let payload;
  try {
    payload = jwt.verify(ticket || '', config.JWT_SECRET, { algorithms: ['HS256'], audience: 'signup' });
  } catch {
    throw fail();
  }
  if (payload.typ !== 'email_verified' || payload.email !== email) throw fail();
  const doc = await EmailVerification.findOneAndUpdate(
    { _id: payload.vid, email, verifiedAt: { $ne: null }, consumedAt: null },
    { $set: { consumedAt: new Date() } },
  );
  if (!doc) throw fail();
  return doc.verifiedAt;
}

// Puts a ticket back after the account/application could not be created (e.g. duplicate).
export async function releaseVerificationTicket(ticket, { config }) {
  try {
    const payload = jwt.verify(ticket, config.JWT_SECRET, { algorithms: ['HS256'], audience: 'signup' });
    await EmailVerification.updateOne({ _id: payload.vid }, { $set: { consumedAt: null } });
  } catch {
    // Expired or invalid: nothing to release.
  }
}
