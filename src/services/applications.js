import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Application } from '../models/index.js';
import { DOCUMENT_TYPES } from '../config/onboarding.js';
import { unauthorized } from '../utils/errors.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U

// e.g. DRV-7K3M9QXT2B4F: 60 random bits, not guessable and not derived from anything else.
export function newApplicationId(role) {
  const bytes = randomBytes(12);
  let id = '';
  for (let i = 0; i < 12; i++) id += ALPHABET[bytes[i] & 31];
  return `${role === 'operator' ? 'OPR' : 'DRV'}-${id}`;
}

// Applicant session: a JWT with its own audience. The normal API middleware rejects it (no
// session jti, no user), so it can only ever reach the /onboarding/me endpoints.
export function issueApplicationToken(app, config) {
  return jwt.sign({ typ: 'application', aid: app.applicationId, ver: app.tokenVersion ?? 0 }, config.JWT_SECRET, {
    algorithm: 'HS256',
    audience: 'application',
    expiresIn: `${config.APPLICATION_SESSION_HOURS}h`,
  });
}

export async function authenticateApplicationToken(token, config) {
  let payload;
  try {
    payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'], audience: 'application' });
  } catch (err) {
    throw unauthorized(err.name === 'TokenExpiredError' ? 'Your application session expired. Sign in again.' : 'Invalid application session');
  }
  if (payload.typ !== 'application' || !payload.aid) throw unauthorized('Invalid application session');
  const app = await Application.findOne({ applicationId: payload.aid });
  // Approval bumps tokenVersion: the applicant must sign in again as a full user.
  if (!app || (app.tokenVersion ?? 0) !== payload.ver) throw unauthorized('Your application session ended. Sign in again.');
  return app;
}

export const historyEntry = (actor, action, detail) => ({
  at: new Date(),
  actor: actor === 'applicant' || actor === 'system' ? actor : actor.userId,
  actorName: actor === 'applicant' ? 'Applicant' : actor === 'system' ? 'System' : actor.fullname,
  action,
  ...(detail ? { detail: String(detail).slice(0, 500) } : {}),
});

const iso = (d) => (d ? new Date(d).toISOString() : null);

// What the applicant (and reviewers) see. Never includes the password hash or storage keys.
export function serializeApplication(app, { forReviewer = false } = {}) {
  const docs = app.documents.map((d) => ({
    type: d.type,
    label: DOCUMENT_TYPES[d.type]?.label ?? d.type,
    why: DOCUMENT_TYPES[d.type]?.why ?? '',
    required: d.required,
    status: d.status,
    file_name: d.originalName,
    size_bytes: d.sizeBytes,
    uploaded_at: iso(d.uploadedAt),
    reviewed_at: iso(d.reviewedAt),
    reason: d.reason,
    version: d.version,
  }));
  return {
    application_id: app.applicationId,
    role: app.role === 'operator' ? 'Operator' : 'Driver',
    status: app.status,
    fullname: app.fullname,
    email: app.email,
    phone_no: app.phoneNo,
    email_verified_at: iso(app.emailVerifiedAt),
    documents: docs,
    submitted_at: iso(app.submittedAt),
    decided_at: iso(app.decidedAt),
    decision_reason: app.decisionReason,
    created_at: iso(app.createdAt),
    updated_at: iso(app.updatedAt),
    history: app.history.map((h) => ({
      at: iso(h.at),
      actor: forReviewer ? h.actorName : h.actor === 'applicant' ? 'You' : h.actor === 'system' ? 'System' : 'Reviewer',
      action: h.action,
      detail: h.detail ?? null,
    })),
    ...(forReviewer ? { employment_verified: app.employmentVerified, user_id: app.userId } : {}),
  };
}

export const missingRequired = (app) =>
  app.documents.filter((d) => d.required && !['pending', 'approved'].includes(d.status)).map((d) => d.type);
export const allRequiredApproved = (app) => app.documents.filter((d) => d.required).every((d) => d.status === 'approved');
