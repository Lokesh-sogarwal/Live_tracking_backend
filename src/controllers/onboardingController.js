import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Application, DriverDocument, User, nextSeq } from '../models/index.js';
import { hashPassword } from '../services/passwords.js';
import { assignableRoles, can, isAdminRole, roleRank } from '../services/roles.js';
import { createNotification, notifyAdmins } from '../services/notifications.js';
import { createMailer } from '../services/mailer.js';
import { MIN_PASSWORD_LENGTH } from '../services/passwordReset.js';
import {
  consumeVerificationTicket, releaseVerificationTicket, sendSignupCode, verifySignupCode,
} from '../services/emailVerification.js';
import {
  allRequiredApproved, historyEntry, issueApplicationToken, missingRequired, newApplicationId, serializeApplication,
} from '../services/applications.js';
import { checklistFor, describeChecklist, DOCUMENT_TYPES } from '../config/onboarding.js';
import { sniffFile } from '../utils/fileSniff.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { emailSchema } from './authController.js';

const docType = z.enum(Object.keys(DOCUMENT_TYPES));
export const schemas = {
  sendCode: z.object({ email: emailSchema }),
  verifyCode: z.object({ email: emailSchema, code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') }),
  createApplication: z.object({
    verification_token: z.string().min(10).max(2000),
    email: emailSchema,
    role: z.enum(['driver', 'operator'], { message: 'Choose Driver or Operator' }),
    fullname: z.string().trim().min(2, 'Enter your full name').max(150),
    phone_no: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid mobile number'),
    password: z.string().min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`).max(200),
  }),
  uploadBody: z.object({ document_type: docType }),
  docParam: z.object({ type: docType }),
  appParam: z.object({ id: z.string().regex(/^(DRV|OPR)-[0-9A-Z]{12}$/, 'Invalid application ID') }),
  appDocParam: z.object({ id: z.string().regex(/^(DRV|OPR)-[0-9A-Z]{12}$/), type: docType }),
  listQuery: z.object({
    status: z.enum(['DOCUMENTS_PENDING', 'UNDER_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'REJECTED']).optional(),
    role: z.enum(['driver', 'operator']).optional(),
    q: z.string().trim().max(100).optional(),
  }),
  reviewDoc: z
    .object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(500).optional() })
    .refine((b) => b.decision === 'approve' || (b.reason && b.reason.length >= 3), { message: 'Give a reason for the rejection', path: ['reason'] }),
  comment: z.object({ comment: z.string().trim().min(3, 'Explain what needs to change').max(500) }),
  reject: z.object({ reason: z.string().trim().min(3, 'Give a reason for the rejection').max(500) }),
  approve: z.object({ employment_verified: z.boolean().optional() }),
};

const OPEN = ['DOCUMENTS_PENDING', 'UNDER_REVIEW', 'ACTION_REQUIRED'];
const unavailable = () =>
  new AppError(503, 'VERIFICATION_UNAVAILABLE', 'Email verification is not set up on this server, so driver and operator applications are closed. Contact an administrator.');

// Reviewer rights, derived from the rules that already exist:
//  - driver documents: same as reviewing driver documents today (operator+, Uploded_documents, drivers)
//  - operator documents, and every final decision: whoever may create that role (admin/superadmin)
async function reviewerRights(req, app) {
  const roleKey = req.roleKey;
  const area = app.role === 'driver' ? 'drivers' : 'users';
  const hasArea = await can(roleKey, area);
  const decide = hasArea && assignableRoles(roleKey).includes(app.role) && app.email !== req.user.email;
  const reviewDocs =
    app.email !== req.user.email &&
    (app.role === 'driver'
      ? roleRank(roleKey) >= roleRank('operator') && hasArea && (await can(roleKey, 'Uploded_documents'))
      : isAdminRole(roleKey) && hasArea);
  return { review_documents: reviewDocs, decide };
}

export function createOnboardingController(ctx) {
  const { config, logger, storage } = ctx;
  const mailer = ctx.mailer ?? createMailer(config);

  // Best effort, after the change is saved: a mail failure never undoes a decision.
  const tellApplicant = (app, subject, text, log) => {
    if (!mailer.enabled) return;
    mailer.send({ to: app.email, subject, text }).catch((err) => log.warn({ err: { message: err.message } }, 'Applicant email failed'));
  };

  const loadForReviewer = async (req) => {
    const app = await Application.findOne({ applicationId: req.params.id });
    if (!app) throw notFound('Application not found');
    const rights = await reviewerRights(req, app);
    if (!rights.review_documents && !rights.decide) throw forbidden();
    return { app, rights };
  };

  const streamDocument = async (res, doc) => {
    if (!doc?.storageKey) throw notFound('No file uploaded for this document');
    const body = await storage.get(doc.storageKey);
    res.set({
      'Content-Type': doc.mimeType || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${(doc.originalName || 'document').replace(/[^\w.-]/g, '_')}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(body);
  };

  return {
    // ---------------- public signup helpers ----------------
    async signupOptions(_req, res) {
      res.json({
        public_signup: config.PUBLIC_SIGNUP_ENABLED,
        email_verification: mailer.enabled,
        applications_open: mailer.enabled && config.PUBLIC_SIGNUP_ENABLED,
        code_ttl_minutes: config.SIGNUP_CODE_TTL_MINUTES,
        documents: { driver: describeChecklist('driver', config), operator: describeChecklist('operator', config) },
      });
    },

    async sendCode(req, res) {
      if (!config.PUBLIC_SIGNUP_ENABLED) throw forbidden('Public signup is disabled');
      if (!mailer.enabled) throw new AppError(503, 'VERIFICATION_UNAVAILABLE', 'Email verification is not set up on this server');
      const { email } = req.body;
      if (await User.exists({ email })) throw conflict('An account with this email already exists. Sign in, or reset your password.');
      if (await Application.exists({ activeEmail: email })) throw conflict('An application for this email is already open. Sign in to continue it.');
      try {
        await sendSignupCode(email, { config, mailer });
      } catch (err) {
        if (err instanceof AppError) throw err;
        (req.log ?? logger).error({ err: { message: err.message } }, 'Signup code email failed');
        throw new AppError(502, 'MAIL_FAILED', 'We could not send the code. Try again in a few minutes.');
      }
      res.json({ message: `We sent a 6-digit code to ${email}. It expires in ${config.SIGNUP_CODE_TTL_MINUTES} minutes.` });
    },

    async verifyCode(req, res) {
      if (!mailer.enabled) throw new AppError(503, 'VERIFICATION_UNAVAILABLE', 'Email verification is not set up on this server');
      const { email, code } = req.body;
      const { ticket, expiresInMinutes } = await verifySignupCode(email, code, { config });
      res.json({ verification_token: ticket, expires_in_minutes: expiresInMinutes });
    },

    // ---------------- applicant ----------------
    async createApplication(req, res) {
      if (!config.PUBLIC_SIGNUP_ENABLED) throw forbidden('Public signup is disabled');
      if (!mailer.enabled) throw unavailable();
      const b = req.body;
      if (await User.exists({ email: b.email })) throw conflict('An account with this email already exists. Sign in, or reset your password.');
      const verifiedAt = await consumeVerificationTicket(b.verification_token, b.email, { config });

      let app;
      try {
        app = await Application.create({
          applicationId: newApplicationId(b.role),
          role: b.role,
          fullname: b.fullname,
          email: b.email,
          activeEmail: b.email,
          phoneNo: b.phone_no,
          passwordHash: await hashPassword(b.password),
          emailVerifiedAt: verifiedAt,
          documents: checklistFor(b.role, config),
          history: [historyEntry('applicant', 'Application started', 'Email verified')],
        });
      } catch (err) {
        await releaseVerificationTicket(b.verification_token, { config });
        if (err.code === 11000) throw conflict('An application for this email is already open. Sign in to continue it.');
        throw err;
      }
      res.status(201).json({ application_token: issueApplicationToken(app, config), application: serializeApplication(app) });
    },

    async me(req, res) {
      res.json(serializeApplication(req.application));
    },

    async uploadDocument(req, res) {
      const app = req.application;
      if (!['DOCUMENTS_PENDING', 'ACTION_REQUIRED'].includes(app.status)) {
        throw conflict(app.status === 'UNDER_REVIEW' ? 'Your application is being reviewed; documents are locked until the reviewer responds.' : 'This application can no longer be changed');
      }
      const { document_type } = req.body;
      const doc = app.documents.find((d) => d.type === document_type);
      if (!doc) throw badRequest('This document is not part of your application');
      if (doc.status === 'approved') throw conflict('This document was already approved');
      if (!req.file) throw badRequest('Choose a file to upload');
      const detected = sniffFile(req.file.buffer, req.file.originalname);
      if (!detected) throw badRequest('Invalid file type. Allowed: pdf, png, jpg, jpeg, docx');

      // Private storage; served only through the authenticated endpoints below.
      const storageKey = `applications/${app.applicationId}/${randomUUID()}.${detected.ext}`;
      await storage.put(storageKey, req.file.buffer, detected.mime);
      const replaced = doc.storageKey ? { storageKey: doc.storageKey, uploadedAt: doc.uploadedAt, status: doc.status, reason: doc.reason } : null;

      // Optimistic concurrency on the document version: two parallel uploads cannot both win.
      const update = {
        $set: {
          'documents.$.status': 'pending',
          'documents.$.storageKey': storageKey,
          'documents.$.originalName': req.file.originalname.slice(0, 255),
          'documents.$.mimeType': detected.mime,
          'documents.$.sizeBytes': req.file.size,
          'documents.$.uploadedAt': new Date(),
          'documents.$.reviewedAt': null,
          'documents.$.reviewedBy': null,
          'documents.$.reason': null,
        },
        $inc: { 'documents.$.version': 1 },
        $push: {
          history: historyEntry('applicant', replaced ? 'Document replaced' : 'Document uploaded', DOCUMENT_TYPES[document_type].label),
          ...(replaced ? { 'documents.$.previous': replaced } : {}),
        },
      };
      const saved = await Application.findOneAndUpdate(
        { _id: app._id, status: app.status, documents: { $elemMatch: { type: document_type, version: doc.version } } },
        update,
        { new: true },
      );
      if (!saved) {
        await storage.remove(storageKey).catch(() => {});
        throw conflict('Your application changed meanwhile. Reload and try again.');
      }
      res.status(201).json({ message: 'Document uploaded', application: serializeApplication(saved) });
    },

    async myDocumentFile(req, res) {
      await streamDocument(res, req.application.documents.find((d) => d.type === req.params.type));
    },

    async submit(req, res) {
      const app = req.application;
      if (!['DOCUMENTS_PENDING', 'ACTION_REQUIRED'].includes(app.status)) throw conflict('This application is not waiting for documents');
      const missing = missingRequired(app);
      if (missing.length) {
        throw badRequest(`Upload the required documents first: ${missing.map((t) => DOCUMENT_TYPES[t].label).join(', ')}`);
      }
      const saved = await Application.findOneAndUpdate(
        { _id: app._id, status: app.status },
        {
          $set: { status: 'UNDER_REVIEW', submittedAt: new Date() },
          $push: { history: historyEntry('applicant', app.status === 'ACTION_REQUIRED' ? 'Resubmitted for review' : 'Submitted for review') },
        },
        { new: true },
      );
      if (!saved) throw conflict('Your application changed meanwhile. Reload and try again.');
      await notifyAdmins(`${saved.role === 'driver' ? 'Driver' : 'Operator'} application ${saved.applicationId} from ${saved.fullname} is ready for review`, 'application', {
        tz: config.APP_TIMEZONE,
        logger: req.log ?? logger,
      });
      res.json({ message: 'Submitted for review', application: serializeApplication(saved) });
    },

    // ---------------- reviewers ----------------
    async list(req, res) {
      const q = req.validatedQuery;
      const filter = {};
      if (q.status) filter.status = q.status;
      if (q.role) filter.role = q.role;
      if (q.q) {
        const rx = new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filter.$or = [{ applicationId: rx }, { fullname: rx }, { email: rx }];
      }
      const apps = await Application.find(filter).sort({ submittedAt: -1, createdAt: -1 }).limit(500);
      const out = [];
      for (const app of apps) {
        const rights = await reviewerRights(req, app);
        if (!rights.review_documents && !rights.decide) continue;
        const s = serializeApplication(app, { forReviewer: true });
        out.push({
          application_id: s.application_id,
          role: s.role,
          status: s.status,
          fullname: s.fullname,
          email: s.email,
          submitted_at: s.submitted_at,
          created_at: s.created_at,
          updated_at: s.updated_at,
          documents: s.documents.map((d) => ({ type: d.type, label: d.label, status: d.status, required: d.required })),
        });
      }
      res.json(out);
    },

    async detail(req, res) {
      const { app, rights } = await loadForReviewer(req);
      res.json({ ...serializeApplication(app, { forReviewer: true }), permissions: rights });
    },

    async reviewerDocumentFile(req, res) {
      const { app } = await loadForReviewer(req);
      await streamDocument(res, app.documents.find((d) => d.type === req.params.type));
    },

    async reviewDocument(req, res) {
      const { app, rights } = await loadForReviewer(req);
      if (!rights.review_documents) throw forbidden('You cannot review documents for this application');
      if (app.status !== 'UNDER_REVIEW') throw conflict('Documents can be reviewed only while the application is under review');
      const { type } = req.params;
      const doc = app.documents.find((d) => d.type === type);
      if (!doc || !doc.storageKey) throw badRequest('Nothing has been uploaded for this document');
      const { decision, reason } = req.body;
      const status = decision === 'approve' ? 'approved' : 'rejected';
      const saved = await Application.findOneAndUpdate(
        { _id: app._id, status: 'UNDER_REVIEW', documents: { $elemMatch: { type, version: doc.version } } },
        {
          $set: { 'documents.$.status': status, 'documents.$.reviewedAt': new Date(), 'documents.$.reviewedBy': req.user._id, 'documents.$.reason': decision === 'reject' ? reason : null },
          $push: { history: historyEntry(req.user, decision === 'approve' ? 'Document approved' : 'Document rejected', `${DOCUMENT_TYPES[type].label}${reason ? `: ${reason}` : ''}`) },
        },
        { new: true },
      );
      if (!saved) throw conflict('The application changed meanwhile. Reload and try again.');
      res.json({ ...serializeApplication(saved, { forReviewer: true }), permissions: rights });
    },

    async requestChanges(req, res) {
      const { app, rights } = await loadForReviewer(req);
      if (!rights.review_documents && !rights.decide) throw forbidden();
      if (app.status !== 'UNDER_REVIEW') throw conflict('Only applications under review can be sent back');
      const saved = await Application.findOneAndUpdate(
        { _id: app._id, status: 'UNDER_REVIEW' },
        { $set: { status: 'ACTION_REQUIRED' }, $push: { history: historyEntry(req.user, 'Changes requested', req.body.comment) } },
        { new: true },
      );
      if (!saved) throw conflict('The application changed meanwhile. Reload and try again.');
      tellApplicant(saved, `Action needed on your application ${saved.applicationId}`, `A reviewer asked for changes:\n\n${req.body.comment}\n\nSign in to update your application.\n`, req.log ?? logger);
      res.json({ ...serializeApplication(saved, { forReviewer: true }), permissions: rights });
    },

    async reject(req, res) {
      const { app, rights } = await loadForReviewer(req);
      if (!rights.decide) throw forbidden('Only an administrator can reject this application');
      if (!OPEN.includes(app.status)) throw conflict('This application has already been decided');
      const saved = await Application.findOneAndUpdate(
        { _id: app._id, status: { $in: OPEN }, activatingAt: null },
        {
          $set: { status: 'REJECTED', decidedAt: new Date(), decidedBy: req.user._id, decisionReason: req.body.reason },
          $unset: { activeEmail: 1 },
          $push: { history: historyEntry(req.user, 'Application rejected', req.body.reason) },
        },
        { new: true },
      );
      if (!saved) throw conflict('The application changed meanwhile. Reload and try again.');
      tellApplicant(saved, `Your application ${saved.applicationId}`, `Your application was not approved.\n\nReason: ${req.body.reason}\n`, req.log ?? logger);
      res.json({ ...serializeApplication(saved, { forReviewer: true }), permissions: rights });
    },

    // Creates the permanent account. Idempotent: the status claim lets exactly one request
    // through, a repeat returns the account already created, and the unique email index on
    // users is a final guard against duplicates.
    async approve(req, res) {
      const log = req.log ?? logger;
      const { app, rights } = await loadForReviewer(req);
      if (!rights.decide) throw forbidden('Only an administrator can approve this application');
      if (app.status === 'APPROVED') {
        return res.json({ ...serializeApplication(app, { forReviewer: true }), permissions: rights, already_approved: true });
      }
      if (app.status !== 'UNDER_REVIEW') throw conflict('Only applications under review can be approved');
      if (!allRequiredApproved(app)) throw badRequest('Approve every required document before approving the application');
      const needsEmployment = app.role === 'operator' && app.documents.some((d) => d.type === 'offer_letter' && d.required);
      if (needsEmployment && req.body.employment_verified !== true) {
        throw badRequest('Confirm that you verified the employment with the employer before approving');
      }

      const stale = new Date(Date.now() - 5 * 60_000);
      const claimed = await Application.findOneAndUpdate(
        { _id: app._id, status: 'UNDER_REVIEW', $or: [{ activatingAt: null }, { activatingAt: { $lt: stale } }] },
        { $set: { activatingAt: new Date() } },
        { new: true },
      ).select('+passwordHash');
      if (!claimed) {
        const now = await Application.findById(app._id);
        if (now?.status === 'APPROVED') return res.json({ ...serializeApplication(now, { forReviewer: true }), permissions: rights, already_approved: true });
        throw conflict('This application is being approved by someone else right now');
      }

      let user = await User.findOne({ applicationId: claimed.applicationId }).lean(); // recovery after a crash
      if (!user) {
        try {
          user = (
            await User.create({
              fullname: claimed.fullname,
              email: claimed.email,
              passwordHash: claimed.passwordHash,
              phoneNo: claimed.phoneNo,
              roleKey: claimed.role,
              isPasswordChange: true,
              emailVerifiedAt: claimed.emailVerifiedAt,
              applicationId: claimed.applicationId,
            })
          ).toObject();
        } catch (err) {
          await Application.updateOne({ _id: claimed._id }, { $set: { activatingAt: null } });
          if (err.code === 11000) throw conflict('An account with this email already exists');
          throw err;
        }
      }

      // Approved driver documents join the existing driver-document records (same files).
      if (claimed.role === 'driver') {
        for (const d of claimed.documents.filter((x) => x.status === 'approved' && ['license', 'aadhaar'].includes(x.type))) {
          if (await DriverDocument.exists({ user: user._id, documentType: d.type })) continue;
          await DriverDocument.create({
            docId: await nextSeq('driverDocuments'),
            user: user._id,
            userId: user.userId,
            documentType: d.type,
            storageKey: d.storageKey,
            originalName: d.originalName,
            mimeType: d.mimeType,
            sizeBytes: d.sizeBytes,
            uploadTime: d.uploadedAt,
            isVerified: true,
            reviewedBy: d.reviewedBy,
            reviewedAt: d.reviewedAt,
          }).catch((err) => log.warn({ err: { message: err.message } }, 'Copying application document failed'));
        }
      }

      const saved = await Application.findOneAndUpdate(
        { _id: claimed._id },
        {
          $set: {
            status: 'APPROVED',
            decidedAt: new Date(),
            decidedBy: req.user._id,
            user: user._id,
            userId: user.userId,
            activatingAt: null,
            employmentVerified: needsEmployment ? true : claimed.employmentVerified,
          },
          $unset: { activeEmail: 1 },
          // Ends the applicant session: they sign in again as a full user.
          $inc: { tokenVersion: 1 },
          $push: {
            history: {
              $each: [
                ...(needsEmployment ? [historyEntry(req.user, 'Employment confirmed', 'Reviewer confirmed the offer letter with the employer')] : []),
                historyEntry(req.user, 'Application approved', `${claimed.role === 'driver' ? 'Driver' : 'Operator'} account activated`),
              ],
            },
          },
        },
        { new: true },
      );
      await createNotification(
        { user, message: `Welcome! Your ${claimed.role} application ${claimed.applicationId} was approved.`, type: 'success' },
        { tz: config.APP_TIMEZONE, logger: log },
      ).catch(() => {});
      tellApplicant(saved, `Your application ${saved.applicationId} was approved`, `Your ${claimed.role} account is active. Sign in with the email and password you chose when you applied.\n`, log);
      res.json({ ...serializeApplication(saved, { forReviewer: true }), permissions: rights });
    },
  };
}
