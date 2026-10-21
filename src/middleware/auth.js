import { authenticateToken, extractBearer } from '../services/tokens.js';
import { authenticateApplicationToken } from '../services/applications.js';
import { can, normalizeRole, roleRank } from '../services/roles.js';
import { AppError, forbidden, unauthorized } from '../utils/errors.js';

export const passwordChangeRequired = () =>
  new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Choose a new password before continuing');

// allowPendingPasswordChange: routes a user holding a temporary password may still call
// (change password, logout). Everything else answers 403 PASSWORD_CHANGE_REQUIRED.
export function authenticate(config, { allowPendingPasswordChange = false } = {}) {
  return async (req, _res, next) => {
    const token = extractBearer(req.headers.authorization);
    if (!token) return next(unauthorized('Authorization header missing'));
    try {
      const { user, jti } = await authenticateToken(token, config);
      if (user.mustChangePassword && !allowPendingPasswordChange) return next(passwordChangeRequired());
      req.user = user;
      req.jti = jti;
      req.roleKey = normalizeRole(user.roleKey);
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

// Attaches req.user when a valid token is present; never rejects. Used by /auth/signup,
// where an admin token unlocks role assignment but anonymous signup is still allowed.
export function optionalAuthenticate(config) {
  return async (req, _res, next) => {
    const token = extractBearer(req.headers.authorization);
    if (!token) return next();
    try {
      const { user, jti } = await authenticateToken(token, config);
      req.user = user;
      req.jti = jti;
      req.roleKey = normalizeRole(user.roleKey);
    } catch {
      // Treated as anonymous.
    }
    return next();
  };
}

// Driver/operator applicants: only their own application, via the scoped application token.
export function authenticateApplicant(config) {
  return async (req, _res, next) => {
    const token = extractBearer(req.headers.authorization);
    if (!token) return next(unauthorized('Sign in to continue your application'));
    try {
      req.application = await authenticateApplicationToken(token, config);
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

export const requirePermission = (featureKey) => async (req, _res, next) => {
  try {
    if (!(await can(req.roleKey, featureKey))) return next(forbidden());
    return next();
  } catch (err) {
    return next(err);
  }
};

export const requireRoles = (...keys) => (req, _res, next) =>
  keys.includes(req.roleKey) ? next() : next(forbidden());

export const requireMinRole = (minKey) => (req, _res, next) =>
  roleRank(req.roleKey) >= roleRank(minKey) ? next() : next(forbidden());
