import { z } from 'zod';
import { Application, PasswordReset, User } from '../models/index.js';
import { hashPassword, verifyPassword } from '../services/passwords.js';
import { issueToken, revokeSession } from '../services/tokens.js';
import { assignableRoles, normalizeRole, roleDisplayName, DEFAULT_ROLES } from '../services/roles.js';
import { notifyAdmins } from '../services/notifications.js';
import { createMailer } from '../services/mailer.js';
import { consumeVerificationTicket, releaseVerificationTicket } from '../services/emailVerification.js';
import { issueApplicationToken } from '../services/applications.js';
import {
  MIN_PASSWORD_LENGTH, hashResetToken, requestAdminReset, resolveAdminRequests, sendResetLink, setPassword,
} from '../services/passwordReset.js';
import { badRequest, conflict, forbidden, notImplemented, unauthorized } from '../utils/errors.js';

export const emailSchema = z
  .string({ required_error: 'Email is required' })
  .trim()
  .toLowerCase()
  .email('Invalid email address')
  .max(150);

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string({ required_error: 'Password is required' }).min(1, 'Password is required').max(200),
});

export const signupSchema = z.object({
  fullname: z.string({ required_error: 'fullname is required' }).trim().min(1, 'fullname is required').max(150),
  email: emailSchema,
  password: z.string({ required_error: 'Password is required' }).max(200),
  role: z.string().trim().max(50).optional(),
  is_password_change: z.coerce.boolean().optional(),
  phone_no: z.string().trim().max(20).optional(),
  // Proof from POST /auth/signup/verify_code; required for public signup when email is configured.
  verification_token: z.string().max(2000).optional(),
});

const newPassword = z
  .string({ required_error: 'Password is required' })
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(200);

export const forgotPasswordSchema = z.object({ email: emailSchema });
export const resetPasswordSchema = z.object({
  token: z.string({ required_error: 'Reset link is invalid' }).trim().min(20, 'Reset link is invalid').max(200),
  password: newPassword,
});
export const changePasswordSchema = z.object({
  current_password: z.string({ required_error: 'Current password is required' }).min(1, 'Current password is required').max(200),
  new_password: newPassword,
});

// Compared against when the email is unknown, so both failure paths cost the same.
let dummyHash;
const getDummyHash = async () => (dummyHash ??= await hashPassword('not-a-real-password'));

export const serializeUser = (u) => ({
  user_uuid: u.userId,
  fullname: u.fullname,
  email: u.email,
  fathername: u.fatherName || '',
  mothername: u.motherName || '',
  dob: u.dob || '',
  phone_no: u.phoneNo ?? null,
  role: roleDisplayName(u.roleKey),
});

export function createAuthController(ctx) {
  const { config, logger } = ctx;
  const mailer = ctx.mailer ?? createMailer(config);

  return {
    async login(req, res) {
      const { email, password } = req.body;
      const user = await User.findOne({ email }).select('+passwordHash').lean();
      // No account yet: maybe a driver/operator applicant (open or rejected application).
      // Exactly one hash check either way, so timing does not reveal which case applied.
      const application = user
        ? null
        : await Application.findOne({ email, status: { $ne: 'APPROVED' } }).sort({ createdAt: -1 }).select('+passwordHash');
      const hash = user?.passwordHash ?? application?.passwordHash ?? (await getDummyHash());
      const { ok, needsRehash } = await verifyPassword(password, hash);
      if (ok && application) {
        return res.json({
          application_token: issueApplicationToken(application, config),
          application_id: application.applicationId,
          application_status: application.status,
        });
      }
      if (!user || !ok) throw unauthorized('Invalid credentials');

      if (needsRehash) {
        // Upgrade legacy Werkzeug hashes to bcrypt on first successful login.
        await User.updateOne({ _id: user._id }, { $set: { passwordHash: await hashPassword(password) } });
      }
      const { token } = await issueToken(user, config);
      res.json(user.mustChangePassword ? { token, must_change_password: true } : { token });
    },

    // Always the same answer, whether or not the email has an account, and the work happens
    // after the response so timing does not reveal it either.
    async forgotPassword(req, res) {
      const { email } = req.body;
      const delivery = mailer.enabled ? 'email' : 'admin';
      const minutes = config.PASSWORD_RESET_TTL_MINUTES;
      res.json({
        delivery,
        message:
          delivery === 'email'
            ? `If an account exists for ${email}, we've emailed it a link to reset the password. The link works for ${minutes} minutes.`
            : `If an account exists for ${email}, an administrator has been asked to reset its password. They will give you a temporary password.`,
      });

      // The response is already sent: nothing below may throw.
      const log = req.log ?? logger;
      const deps = { config, logger: log, mailer };
      let user;
      try {
        user = await User.findOne({ email }).lean();
        if (!user) return;
        if (mailer.enabled) await sendResetLink(user, deps);
        else await requestAdminReset(user, deps);
      } catch (err) {
        if (!user) return log.error({ err: { message: err.message } }, 'Password reset lookup failed');
        log.error({ err: { message: err.message } }, 'Password reset email failed; asking administrators instead');
        await requestAdminReset(user, deps).catch((e) => log.error({ err: { message: e.message } }, 'Password reset request failed'));
      }
    },

    async resetPassword(req, res) {
      const { token, password } = req.body;
      const now = new Date();
      // Consumed atomically, so a link cannot be used twice even by parallel requests.
      const reset = await PasswordReset.findOneAndUpdate(
        { tokenHash: hashResetToken(token), channel: 'email', usedAt: null, expiresAt: { $gt: now } },
        { $set: { usedAt: now } },
      ).lean();
      if (!reset) throw badRequest('This reset link is invalid or has expired. Request a new one.');
      const user = await User.findById(reset.user).lean();
      if (!user) throw badRequest('This reset link is invalid or has expired. Request a new one.');
      await setPassword(user, password, { mustChange: false });
      await resolveAdminRequests(user);
      res.json({ message: 'Your password has been changed. Sign in with your new password.' });
    },

    async changePassword(req, res) {
      const { current_password, new_password } = req.body;
      const user = await User.findById(req.user._id).select('+passwordHash').lean();
      const { ok } = await verifyPassword(current_password, user.passwordHash);
      if (!ok) throw badRequest('Your current password is incorrect');
      if (current_password === new_password) throw badRequest('Choose a password different from the current one');
      await setPassword(user, new_password, { mustChange: false });
      await resolveAdminRequests(user);
      // Every session (this one included) was revoked; hand back a fresh token.
      const { token } = await issueToken({ ...user, mustChangePassword: false, isPasswordChange: true }, config);
      res.json({ message: 'Password changed', token });
    },

    async logout(req, res) {
      await revokeSession(req.jti);
      res.json({ message: 'Logged out successfully' });
    },

    async signup(req, res) {
      const body = req.body;
      const requested = normalizeRole(body.role || 'passenger');
      if (!DEFAULT_ROLES.some((r) => r.key === requested)) throw forbidden('Unknown role');

      const isAdminCreate = Boolean(req.user);
      if (!isAdminCreate && !config.PUBLIC_SIGNUP_ENABLED) throw forbidden('Public signup is disabled');
      // Anonymous signup can only create passengers; admins can assign roles below their own.
      if (!assignableRoles(req.roleKey).includes(requested)) throw forbidden('You are not allowed to assign this role');

      // Admin-created accounts use the UI's generated initial password (fullname + "123"),
      // so the minimum is relaxed for them; self-signup follows the UI's 8-character hint.
      const minLength = isAdminCreate ? 6 : 8;
      if (body.password.length < minLength) throw badRequest(`Password must be at least ${minLength} characters`);

      if (await User.exists({ email: body.email })) throw conflict('User already exists');
      if (await Application.exists({ activeEmail: body.email })) throw conflict('An application for this email is already open');

      // Public signup must prove the email when the server can send mail. Without mail it
      // stays as before (unverified) — see docs/ONBOARDING.md.
      let emailVerifiedAt = null;
      if (!isAdminCreate && mailer.enabled) {
        if (!body.verification_token) throw badRequest('Verify your email first');
        emailVerifiedAt = await consumeVerificationTicket(body.verification_token, body.email, { config });
      }

      let user;
      try {
        user = await User.create({
          fullname: body.fullname,
          email: body.email,
          passwordHash: await hashPassword(body.password),
          isPasswordChange: Boolean(body.is_password_change),
          phoneNo: body.phone_no || null,
          roleKey: requested,
          emailVerifiedAt,
        });
      } catch (err) {
        if (emailVerifiedAt) await releaseVerificationTicket(body.verification_token, { config });
        if (err.code === 11000) throw conflict('User already exists');
        throw err;
      }

      await notifyAdmins(
        `New User Registered: ${user.fullname} (${user.email}) as ${roleDisplayName(requested)}`,
        'info',
        { tz: config.APP_TIMEZONE, logger: req.log ?? logger },
      );
      res.status(200).json({ message: 'User and Role assigned successfully', ...serializeUser(user) });
    },

    async verifyOtp() {
      throw notImplemented('OTP verification is not implemented on this server');
    },
  };
}
