import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';

const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

// GeoJSON points are always stored as [longitude, latitude].
const pointSchema = new Schema(
  {
    type: { type: String, enum: ['Point'], default: 'Point', required: true },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: (c) => c.length === 2 && c[0] >= -180 && c[0] <= 180 && c[1] >= -90 && c[1] <= 90,
        message: 'coordinates must be [lng, lat] within valid ranges',
      },
    },
  },
  { _id: false },
);

// ---------------------------------------------------------------------------
// Counters: numeric public ids (bus_id, route_id, ...) that the React UI and the
// legacy URLs (/view/get_location/:bus_id) depend on.
// ---------------------------------------------------------------------------
const counterSchema = new Schema({ _id: String, seq: { type: Number, default: 0 } }, { versionKey: false });
export const Counter = model('Counter', counterSchema, 'counters');

export async function nextSeq(name, session) {
  const doc = await Counter.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session },
  );
  return doc.seq;
}

// ---------------------------------------------------------------------------
// Roles & permissions
// ---------------------------------------------------------------------------
const roleSchema = new Schema(
  {
    roleId: { type: Number, required: true, unique: true },
    key: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true },
  },
  { timestamps: true },
);
export const Role = model('Role', roleSchema, 'roles');

const rolePermissionSchema = new Schema(
  {
    roleKey: { type: String, required: true, lowercase: true },
    featureKey: { type: String, required: true, maxlength: 100 },
    allowed: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);
rolePermissionSchema.index({ roleKey: 1, featureKey: 1 }, { unique: true });
export const RolePermission = model('RolePermission', rolePermissionSchema, 'rolePermissions');

// ---------------------------------------------------------------------------
// Users & sessions
// ---------------------------------------------------------------------------
const userSchema = new Schema(
  {
    userId: { type: String, required: true, unique: true, default: () => randomUUID() },
    legacyId: { type: Number, unique: true, sparse: true },
    fullname: { type: String, required: true, trim: true, maxlength: 150 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 150 },
    passwordHash: { type: String, required: true, select: false },
    phoneNo: { type: String, maxlength: 20, default: null },
    isPasswordChange: { type: Boolean, default: false },
    // Set when an administrator issues a temporary password; the API then only accepts
    // /auth/change_password and /auth/logout for this user until a new password is chosen.
    mustChangePassword: { type: Boolean, default: false },
    // Set when the email was proven with a signup code; null for accounts created before that
    // existed, by an administrator, or while email is not configured.
    emailVerifiedAt: { type: Date, default: null },
    // Driver/operator accounts activated from an approved application (e.g. "DRV-…").
    applicationId: { type: String, default: null },
    roleKey: { type: String, required: true, lowercase: true, default: 'passenger', index: true },
    dob: { type: String, default: '' },
    fatherName: { type: String, default: '', maxlength: 150 },
    motherName: { type: String, default: '', maxlength: 150 },
  },
  { timestamps: true },
);
userSchema.index({ createdAt: -1 });
export const User = model('User', userSchema, 'users');

// One document per issued JWT (jti). Replaces the legacy Active_user table and makes
// logout a real server-side revocation.
const sessionSchema = new Schema(
  {
    jti: { type: String, required: true, unique: true },
    user: { type: ObjectId, ref: 'User', required: true, index: true },
    userId: { type: String, required: true },
    fullname: String,
    email: String,
    roleKey: String,
    loginAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    purgeAt: { type: Date, required: true },
  },
  { versionKey: false },
);
sessionSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
sessionSchema.index({ revokedAt: 1, expiresAt: 1, loginAt: -1 });
export const Session = model('Session', sessionSchema, 'activeSessions');

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------
const busSchema = new Schema(
  {
    busId: { type: Number, required: true, unique: true },
    busNumber: { type: String, required: true, unique: true, trim: true, maxlength: 50 },
    capacity: { type: Number, min: 0, max: 1000, default: null },
    operator: { type: String, maxlength: 150, default: null },
    busType: { type: String, maxlength: 50, default: null },
  },
  { timestamps: true },
);
export const Bus = model('Bus', busSchema, 'buses');

const routeSchema = new Schema(
  {
    routeId: { type: Number, required: true, unique: true },
    routeName: { type: String, required: true, trim: true, maxlength: 100 },
    startPoint: { type: String, required: true, maxlength: 300 },
    start: { type: pointSchema, required: true },
    endPoint: { type: String, required: true, maxlength: 300 },
    end: { type: pointSchema, required: true },
  },
  { timestamps: true },
);
routeSchema.index({ start: '2dsphere' });
routeSchema.index({ startPoint: 1 });
routeSchema.index({ endPoint: 1 });
export const Route = model('Route', routeSchema, 'routes');

const stopSchema = new Schema(
  {
    stopId: { type: Number, required: true, unique: true },
    route: { type: ObjectId, ref: 'Route', required: true },
    name: { type: String, required: true, maxlength: 300 },
    location: { type: pointSchema, required: true },
    sequence: { type: Number, required: true, min: 1 },
  },
  { timestamps: true },
);
stopSchema.index({ route: 1, sequence: 1 });
export const Stop = model('Stop', stopSchema, 'stops');

// Cached road geometry for a route ([lng, lat] LineString), shared by the API's
// /view/api/get_route proxy and the worker's simulation.
const routeGeometrySchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    coordinates: { type: [[Number]], required: true },
    durationSeconds: Number,
    distanceMeters: Number,
    provider: { type: String, enum: ['ors', 'fallback'], required: true },
    fetchedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);
routeGeometrySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const RouteGeometry = model('RouteGeometry', routeGeometrySchema, 'routeGeometries');

const scheduleSchema = new Schema(
  {
    scheduleId: { type: Number, required: true, unique: true },
    route: { type: ObjectId, ref: 'Route', required: true },
    bus: { type: ObjectId, ref: 'Bus', required: true },
    driver: { type: ObjectId, ref: 'User', required: true },
    stop: { type: ObjectId, ref: 'Stop', default: null },
    arrivalTime: { type: Date, required: true },
    departureTime: { type: Date, required: true },
    // on_time (scheduled) | running | delayed (set by an operator) | cancelled |
    // arrived (completed on time) | delayed_completed (reached the destination after departureTime)
    status: { type: String, default: 'on_time', maxlength: 50 },
    currentIndex: { type: Number, default: 0, min: 0 },
    arrivedAt: { type: Date, default: null }, // when the destination was reached
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    isReached: { type: Boolean, default: false },
    direction: { type: String, enum: ['forward', 'reverse'], default: 'forward' },
  },
  { timestamps: true },
);
// Compound uniqueness rule: one trip per bus, per route, per day, per departure time.
// (The legacy UNIQUE(date, route_id, bus_id, stop_id) never fired because stop_id was NULL.)
scheduleSchema.index({ date: 1, route: 1, bus: 1, departureTime: 1 }, { unique: true });
scheduleSchema.index({ date: 1, isReached: 1, arrivalTime: 1 });
scheduleSchema.index({ bus: 1, date: 1 });
scheduleSchema.index({ driver: 1, date: 1 });
scheduleSchema.index({ route: 1, arrivalTime: 1 });
export const Schedule = model('Schedule', scheduleSchema, 'schedules');

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------
const busLocationSchema = new Schema(
  {
    bus: { type: ObjectId, ref: 'Bus', required: true, unique: true },
    busId: { type: Number, required: true, unique: true },
    location: { type: pointSchema, required: true },
    recordedAt: { type: Date, required: true },
    source: { type: String, enum: ['device', 'simulation', 'admin', 'migration'], required: true },
    schedule: { type: ObjectId, ref: 'Schedule', default: null },
    // Numeric id of that trip, stored so every payload (REST and Socket.IO) can say which
    // trip a position belongs to without a lookup. null: not tied to a trip.
    scheduleId: { type: Number, default: null },
  },
  { timestamps: true },
);
busLocationSchema.index({ location: '2dsphere' });
busLocationSchema.index({ updatedAt: 1 }); // location relay (src/services/locationRelay.js)
export const BusLocation = model('BusLocation', busLocationSchema, 'busLocations');

const locationEventSchema = new Schema(
  {
    busId: { type: Number, required: true },
    location: { type: pointSchema, required: true },
    recordedAt: { type: Date, required: true },
    source: String,
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
locationEventSchema.index({ busId: 1, recordedAt: -1 });
locationEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const LocationEvent = model('LocationEvent', locationEventSchema, 'locationEvents');

// ---------------------------------------------------------------------------
// Documents, notifications, feedback, chat
// ---------------------------------------------------------------------------
const driverDocumentSchema = new Schema(
  {
    docId: { type: Number, required: true, unique: true },
    user: { type: ObjectId, ref: 'User', required: true },
    userId: { type: String, required: true },
    documentType: { type: String, required: true, maxlength: 100 },
    storageKey: { type: String, required: true },
    originalName: { type: String, maxlength: 255 },
    mimeType: String,
    sizeBytes: Number,
    uploadTime: { type: Date, default: Date.now },
    expiryDate: { type: Date, default: null },
    isVerified: { type: Boolean, default: false },
    isRejected: { type: Boolean, default: false },
    reviewedBy: { type: ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    fileMissing: { type: Boolean, default: false },
  },
  { timestamps: true },
);
driverDocumentSchema.index({ user: 1, documentType: 1 }, { unique: true });
driverDocumentSchema.index({ uploadTime: -1 });
export const DriverDocument = model('DriverDocument', driverDocumentSchema, 'driverDocuments');

const notificationSchema = new Schema(
  {
    notificationId: { type: Number, required: true, unique: true },
    user: { type: ObjectId, ref: 'User', required: true },
    message: { type: String, required: true, maxlength: 250 },
    type: { type: String, required: true, default: 'info', maxlength: 50 },
    sender: { type: ObjectId, ref: 'User', default: null },
    isRead: { type: Boolean, default: false },
    // In-app path the notification opens (e.g. /my_feedback/12); null for plain notices.
    link: { type: String, maxlength: 200, default: null },
  },
  { timestamps: true },
);
notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ user: 1, type: 1, isRead: 1, sender: 1 });
export const Notification = model('Notification', notificationSchema, 'notifications');

export const FEEDBACK_CATEGORIES = ['general', 'service', 'safety', 'app', 'other'];
export const FEEDBACK_STATUSES = ['new', 'in_review', 'replied', 'resolved'];
const feedbackSchema = new Schema(
  {
    feedbackId: { type: Number, required: true, unique: true },
    user: { type: ObjectId, ref: 'User', required: true },
    email: { type: String, required: true },
    message: { type: String, required: true, maxlength: 5000 },
    // Added with feedback replies; older documents read as subject "", general, normal, new.
    subject: { type: String, maxlength: 150, default: '' },
    category: { type: String, enum: FEEDBACK_CATEGORIES, default: 'general' },
    priority: { type: String, enum: ['low', 'normal', 'high'], default: 'normal' },
    status: { type: String, enum: FEEDBACK_STATUSES, default: 'new' },
    lastReplyAt: { type: Date, default: null },
    replyCount: { type: Number, default: 0 },
    // Audit trail for staff: status/priority changes, replies, email delivery attempts.
    history: [
      {
        _id: false,
        at: { type: Date, default: Date.now },
        actor: String, // userId, or "system"
        actorName: String,
        action: { type: String, required: true },
        detail: { type: String, maxlength: 300 },
      },
    ],
  },
  { timestamps: true },
);
feedbackSchema.index({ createdAt: -1 });
feedbackSchema.index({ user: 1, createdAt: -1 });
feedbackSchema.index({ status: 1, createdAt: -1 });
export const Feedback = model('Feedback', feedbackSchema, 'feedback');

// Staff replies. Immutable once written (no edit/delete endpoint). Email delivery is tracked
// per reply; claimedAt makes each send attempt happen at most once.
const feedbackReplySchema = new Schema(
  {
    feedback: { type: ObjectId, ref: 'Feedback', required: true, index: true },
    author: { type: ObjectId, ref: 'User', required: true },
    authorUserId: { type: String, required: true },
    authorName: { type: String, required: true },
    authorRole: { type: String, required: true },
    message: { type: String, required: true, maxlength: 5000 },
    idempotencyKey: { type: String, default: undefined },
    email: {
      status: { type: String, enum: ['pending', 'sent', 'failed', 'skipped'], required: true },
      skipReason: { type: String, default: null }, // not_configured | unverified_email
      to: { type: String, default: null },
      attempts: { type: Number, default: 0 },
      claimedAt: { type: Date, default: null },
      sentAt: { type: Date, default: null },
      lastError: { type: String, maxlength: 200, default: null },
    },
  },
  { timestamps: true, versionKey: false },
);
feedbackReplySchema.index({ feedback: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
export const FeedbackReply = model('FeedbackReply', feedbackReplySchema, 'feedbackReplies');

const chatMessageSchema = new Schema(
  {
    messageId: { type: String, required: true, unique: true, default: () => randomUUID() },
    legacyId: { type: Number, unique: true, sparse: true },
    sender: { type: ObjectId, ref: 'User', required: true },
    receiver: { type: ObjectId, ref: 'User', required: true },
    senderUserId: { type: String, required: true },
    receiverUserId: { type: String, required: true },
    conversationKey: { type: String, required: true },
    message: { type: String, required: true },
    clientMessageId: { type: String, maxlength: 100 },
  },
  { timestamps: true },
);
chatMessageSchema.index({ conversationKey: 1, createdAt: -1 });
// Makes client retries idempotent: the same clientMessageId from the same sender is stored once.
chatMessageSchema.index(
  { senderUserId: 1, clientMessageId: 1 },
  { unique: true, partialFilterExpression: { clientMessageId: { $type: 'string' } } },
);
export const ChatMessage = model('ChatMessage', chatMessageSchema, 'chatMessages');

// ---------------------------------------------------------------------------
// Worker bookkeeping
// ---------------------------------------------------------------------------
const jobLockSchema = new Schema(
  { _id: String, owner: String, leaseUntil: Date },
  { versionKey: false },
);
export const JobLock = model('JobLock', jobLockSchema, 'jobLocks');

// Written by the leader worker so the API (and the UI) can tell "the worker is not running"
// or "simulation is off" apart from a network problem. One document, _id "worker".
const workerStatusSchema = new Schema(
  {
    _id: String,
    instance: String, // random per process, not a hostname
    startedAt: Date,
    heartbeatAt: Date,
    simulationEnabled: Boolean,
    simulationTickMs: Number,
    lastSimulationTickAt: Date,
    lastSimulationMoved: Number,
    lastScheduleCheckAt: Date,
    lastError: { at: Date, job: String, message: String, busId: Number, scheduleId: Number },
  },
  { versionKey: false },
);
export const WorkerStatus = model('WorkerStatus', workerStatusSchema, 'workerStatus');

const jobRunSchema = new Schema(
  {
    job: { type: String, required: true },
    runKey: { type: String, required: true },
    status: { type: String, enum: ['running', 'succeeded', 'skipped', 'failed'], required: true },
    attempts: { type: Number, default: 0 },
    owner: String, // worker that claimed the run
    startedAt: Date,
    finishedAt: Date,
    result: Schema.Types.Mixed,
    error: String,
  },
  { timestamps: true },
);
jobRunSchema.index({ job: 1, runKey: 1 }, { unique: true });
export const JobRun = model('JobRun', jobRunSchema, 'jobRuns');

// "Forgot password" requests. channel "email": one-time link whose SHA-256 hash is stored
// (never the token). channel "admin": waits for an administrator to issue a temporary password.
const passwordResetSchema = new Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true, index: true },
    channel: { type: String, enum: ['email', 'admin'], required: true },
    tokenHash: { type: String, default: undefined },
    expiresAt: { type: Date, default: null },
    usedAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: ObjectId, ref: 'User', default: null },
    purgeAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false },
);
passwordResetSchema.index({ tokenHash: 1 }, { unique: true, partialFilterExpression: { tokenHash: { $type: 'string' } } });
passwordResetSchema.index({ channel: 1, resolvedAt: 1, createdAt: -1 });
passwordResetSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
export const PasswordReset = model('PasswordReset', passwordResetSchema, 'passwordResets');

// One-time email codes for signup. Only an HMAC of the code is stored.
const emailVerificationSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    sendCount: { type: Number, default: 1 },
    windowStartedAt: { type: Date, default: Date.now },
    lastSentAt: { type: Date, default: Date.now },
    verifiedAt: { type: Date, default: null },
    consumedAt: { type: Date, default: null },
    purgeAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false },
);
emailVerificationSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
export const EmailVerification = model('EmailVerification', emailVerificationSchema, 'emailVerifications');

// Driver/operator applications. Kept apart from users: no User document (and no permanent
// userId) exists until an authorised reviewer approves the application.
export const APPLICATION_STATUSES = ['DOCUMENTS_PENDING', 'UNDER_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'REJECTED'];
const applicationDocumentSchema = new Schema(
  {
    type: { type: String, required: true },
    required: { type: Boolean, default: true },
    status: { type: String, enum: ['missing', 'pending', 'approved', 'rejected'], default: 'missing' },
    storageKey: { type: String, default: null },
    originalName: { type: String, maxlength: 255, default: null },
    mimeType: { type: String, default: null },
    sizeBytes: { type: Number, default: null },
    uploadedAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: ObjectId, ref: 'User', default: null },
    reason: { type: String, maxlength: 500, default: null },
    version: { type: Number, default: 0 },
    previous: [{ _id: false, storageKey: String, uploadedAt: Date, status: String, reason: String }],
  },
  { _id: false },
);
const applicationSchema = new Schema(
  {
    applicationId: { type: String, required: true, unique: true },
    role: { type: String, enum: ['driver', 'operator'], required: true },
    fullname: { type: String, required: true, trim: true, maxlength: 150 },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 150, index: true },
    // Equals email while the application is open; unset once approved or rejected, so one
    // person cannot hold two open applications.
    activeEmail: { type: String, default: undefined },
    phoneNo: { type: String, maxlength: 20, required: true },
    passwordHash: { type: String, required: true, select: false },
    emailVerifiedAt: { type: Date, required: true },
    status: { type: String, enum: APPLICATION_STATUSES, default: 'DOCUMENTS_PENDING', index: true },
    documents: [applicationDocumentSchema],
    history: [
      {
        _id: false,
        at: { type: Date, default: Date.now },
        actor: { type: String, required: true }, // "applicant", "system" or a reviewer's userId
        actorName: String,
        action: { type: String, required: true },
        detail: { type: String, maxlength: 500 },
      },
    ],
    submittedAt: { type: Date, default: null },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: ObjectId, ref: 'User', default: null },
    decisionReason: { type: String, maxlength: 500, default: null },
    employmentVerified: { type: Boolean, default: false },
    activatingAt: { type: Date, default: null },
    user: { type: ObjectId, ref: 'User', default: null },
    userId: { type: String, default: null },
    tokenVersion: { type: Number, default: 0 },
  },
  { timestamps: true },
);
applicationSchema.index({ activeEmail: 1 }, { unique: true, partialFilterExpression: { activeEmail: { $type: 'string' } } });
applicationSchema.index({ status: 1, role: 1, submittedAt: 1 });
export const Application = model('Application', applicationSchema, 'applications');

export const ALL_MODELS = [
  Counter, Role, RolePermission, User, Session, Bus, Route, Stop, RouteGeometry, Schedule,
  BusLocation, LocationEvent, DriverDocument, Notification, Feedback, ChatMessage, JobLock, JobRun,
  PasswordReset, EmailVerification, Application, FeedbackReply, WorkerStatus,
];

// Non-destructive: creates missing indexes, never drops existing ones.
export async function ensureIndexes() {
  for (const m of ALL_MODELS) await m.createIndexes();
}
