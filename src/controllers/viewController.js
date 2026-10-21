import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  Bus, BusLocation, DriverDocument, FEEDBACK_CATEGORIES, Feedback, Notification, PasswordReset, Schedule, Session, User, nextSeq,
} from '../models/index.js';
import { generateTemporaryPassword, resolveAdminRequests, setPassword } from '../services/passwordReset.js';
import { readTrackingStatus } from '../services/workerStatus.js';
import { tripLifecycle } from '../services/tripLifecycle.js';
import { can, isAdminRole, roleRank } from '../services/roles.js';
import { recordLocation, serializeLocation } from '../services/locations.js';
import { isValidLat, isValidLng } from '../services/geo.js';
import { serializeNotification } from '../services/notifications.js';
import { withTransaction } from '../db.js';
import { sniffFile } from '../utils/fileSniff.js';
import { parsePagination } from '../utils/pagination.js';
import { todayInTz } from '../utils/time.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { emailSchema, serializeUser } from './authController.js';

const uuid = z.string().uuid('Invalid user id');

export const schemas = {
  userUuidBody: z.object({ user_uuid: uuid }).passthrough(),
  editUser: z
    .object({
      user_uuid: uuid,
      fullname: z.string().trim().min(1).max(150).optional(),
      email: emailSchema.optional(),
    })
    .passthrough(),
  profileUpdate: z
    .object({
      fullname: z.string().trim().min(1).max(150).optional(),
      email: emailSchema.optional(),
      dob: z.string().trim().max(20).optional(),
      fathername: z.string().trim().max(150).optional(),
      mothername: z.string().trim().max(150).optional(),
      phone_no: z.string().trim().max(20).optional(),
    })
    .passthrough(),
  uploadParams: z.object({ user_id: uuid }),
  uploadBody: z.object({
    document_type: z
      .string()
      .trim()
      .min(1, 'document_type is required')
      .max(100)
      .regex(/^[\w .-]+$/, 'document_type contains invalid characters')
      .default('general'),
    expiry_date: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v ? v : undefined))
      .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid expiry date format, use YYYY-MM-DD').optional()),
  }),
  updateLocation: z.object({
    bus_id: z.coerce.number().int().positive(),
    latitude: z.coerce.number().refine(isValidLat, 'latitude must be between -90 and 90'),
    longitude: z.coerce.number().refine(isValidLng, 'longitude must be between -180 and 180'),
    timestamp: z.union([z.string().datetime({ offset: true }), z.number().int().positive()]).optional(),
  }),
  busIdParam: z.object({ bus_id: z.coerce.number().int().positive() }),
  // Optional: only answer with a position produced by this trip.
  locationQuery: z.object({ schedule_id: z.coerce.number().int().positive().optional() }),
  routeParams: z.object({
    start_lat: z.coerce.number().refine(isValidLat, 'Invalid start_lat'),
    start_lng: z.coerce.number().refine(isValidLng, 'Invalid start_lng'),
    end_lat: z.coerce.number().refine(isValidLat, 'Invalid end_lat'),
    end_lng: z.coerce.number().refine(isValidLng, 'Invalid end_lng'),
  }),
  feedback: z.object({
    feedback: z.string({ required_error: 'feedback is required' }).trim().min(1, 'feedback is required').max(5000),
    subject: z.string().trim().max(150).optional(),
    category: z.enum(FEEDBACK_CATEGORIES).optional(),
  }),
  notifParam: z.object({ notif_id: z.coerce.number().int().positive() }),
};

// Acting on another user's account needs an admin role, the feature permission for the
// target's area (users vs drivers) and a strictly higher role than the target.
async function assertCanManage(req, target) {
  if (!isAdminRole(req.roleKey)) throw forbidden('Unauthorized: Admins only');
  const feature = target.roleKey === 'driver' ? 'drivers' : 'users';
  if (!(await can(req.roleKey, feature))) throw forbidden();
  if (req.roleKey !== 'superadmin' && roleRank(target.roleKey) >= roleRank(req.roleKey)) {
    throw forbidden('You cannot manage a user with an equal or higher role');
  }
}

export function createViewController(ctx) {
  const { config, storage } = ctx;
  const tz = config.APP_TIMEZONE;

  const listUsers = async (req, filter) => {
    const { limit, skip } = parsePagination(req.query, { defaultLimit: 500, maxLimit: 1000 });
    const users = await User.find(filter).sort({ createdAt: 1 }).skip(skip).limit(limit).lean();
    return users.map(serializeUser);
  };

  return {
    async userDetails(req, res) {
      res.json(await listUsers(req, { roleKey: { $ne: 'driver' } }));
    },

    async driverDetails(req, res) {
      res.json(await listUsers(req, { roleKey: 'driver' }));
    },

    async getProfile(req, res) {
      res.json(serializeUser(req.user));
    },

    async updateProfile(req, res) {
      const b = req.body;
      const update = {};
      if (b.fullname !== undefined) update.fullname = b.fullname;
      if (b.dob !== undefined) update.dob = b.dob;
      if (b.fathername !== undefined) update.fatherName = b.fathername;
      if (b.mothername !== undefined) update.motherName = b.mothername;
      if (b.phone_no !== undefined) update.phoneNo = b.phone_no || null;
      if (b.email !== undefined && b.email !== req.user.email) {
        if (await User.exists({ email: b.email, _id: { $ne: req.user._id } })) throw conflict('Email is already in use');
        update.email = b.email;
      }
      // `role` and any other field in the body are ignored: users cannot change their own role.
      const user = await User.findByIdAndUpdate(req.user._id, { $set: update }, { new: true }).lean();
      res.json(serializeUser(user));
    },

    async deleteUser(req, res) {
      const { user_uuid } = req.body;
      if (user_uuid === req.user.userId) throw forbidden('You cannot delete your own account');
      const target = await User.findOne({ userId: user_uuid }).lean();
      if (!target) throw notFound('User not found');
      await assertCanManage(req, target);

      // Mirrors the legacy ON DELETE CASCADE foreign keys. Chat messages are kept so the
      // other participant's history survives (the legacy FK had no cascade there).
      const docs = await DriverDocument.find({ user: target._id }, { storageKey: 1 }).lean();
      await withTransaction(async (session) => {
        const opts = { session };
        await Session.deleteMany({ user: target._id }, opts);
        await Notification.deleteMany({ user: target._id }, opts);
        await Feedback.deleteMany({ user: target._id }, opts);
        await DriverDocument.deleteMany({ user: target._id }, opts);
        await PasswordReset.deleteMany({ user: target._id }, opts);
        await Schedule.deleteMany({ driver: target._id }, opts);
        await User.deleteOne({ _id: target._id }, opts);
      });
      for (const d of docs) await storage.remove(d.storageKey).catch(() => {});
      res.json({ message: `User ${user_uuid} deleted successfully` });
    },

    // Open "forgot password" requests (admin channel) for users this caller may manage.
    async passwordResetRequests(req, res) {
      const open = await PasswordReset.find({ channel: 'admin', resolvedAt: null }).sort({ createdAt: 1 }).limit(200).lean();
      const users = await User.find({ _id: { $in: open.map((r) => r.user) } }).lean();
      const byId = new Map(users.map((u) => [String(u._id), u]));
      const out = [];
      for (const r of open) {
        const u = byId.get(String(r.user));
        if (!u || u.userId === req.user.userId) continue;
        try {
          await assertCanManage(req, u);
        } catch {
          continue;
        }
        out.push({ ...serializeUser(u), requested_at: r.createdAt.toISOString() });
      }
      res.json(out);
    },

    // Issues a temporary password, shown once to the administrator. The user must choose a
    // new password at next sign-in, and every existing session of theirs is ended.
    async resetUserPassword(req, res) {
      const { user_uuid } = req.body;
      if (user_uuid === req.user.userId) throw forbidden('Use "Change password" for your own account');
      const target = await User.findOne({ userId: user_uuid }).lean();
      if (!target) throw notFound('User not found');
      await assertCanManage(req, target);

      const temporaryPassword = generateTemporaryPassword();
      await setPassword(target, temporaryPassword, { mustChange: true });
      await resolveAdminRequests(target, req.user);
      res.set('Cache-Control', 'no-store');
      res.json({
        message: `Temporary password set for ${target.fullname}. They must choose a new password when they sign in.`,
        temporary_password: temporaryPassword,
      });
    },

    async editUser(req, res) {
      const { user_uuid, fullname, email } = req.body;
      const target = await User.findOne({ userId: user_uuid }).lean();
      if (!target) throw notFound('User not found');
      if (user_uuid !== req.user.userId) await assertCanManage(req, target);

      const update = {};
      if (fullname !== undefined) update.fullname = fullname;
      if (email !== undefined && email !== target.email) {
        if (await User.exists({ email, _id: { $ne: target._id } })) throw conflict('Email is already in use');
        update.email = email;
      }
      // Legacy behaviour: only fullname and email are editable here; `role` is ignored.
      const user = await User.findByIdAndUpdate(target._id, { $set: update }, { new: true }).lean();
      res.json({ fullname: user.fullname, email: user.email });
    },

    async uploadDocument(req, res) {
      const { user_id } = req.params;
      const { document_type, expiry_date } = req.body;
      const isSelf = user_id === req.user.userId;
      if (isSelf ? !(await can(req.roleKey, 'upload')) : roleRank(req.roleKey) < roleRank('operator') || !(await can(req.roleKey, 'drivers'))) {
        throw forbidden();
      }
      if (!req.file) throw badRequest('No file part in request');

      const target = isSelf ? req.user : await User.findOne({ userId: user_id }).lean();
      if (!target) throw notFound('User not found');

      const detected = sniffFile(req.file.buffer, req.file.originalname);
      if (!detected) throw badRequest('Invalid file type. Allowed: pdf, png, jpg, jpeg, docx');

      if (await DriverDocument.exists({ user: target._id, documentType: document_type })) {
        throw conflict(`${document_type} already exists for this user`);
      }

      const storageKey = `driver-docs/${target.userId}/${randomUUID()}.${detected.ext}`;
      await storage.put(storageKey, req.file.buffer, detected.mime);
      try {
        const doc = await DriverDocument.create({
          docId: await nextSeq('driverDocuments'),
          user: target._id,
          userId: target.userId,
          documentType: document_type,
          storageKey,
          originalName: req.file.originalname.slice(0, 255),
          mimeType: detected.mime,
          sizeBytes: req.file.size,
          expiryDate: expiry_date ? new Date(`${expiry_date}T00:00:00Z`) : null,
        });
        res.status(201).json({ message: 'File uploaded successfully', id: doc.docId, document_type });
      } catch (err) {
        await storage.remove(storageKey).catch(() => {});
        if (err.code === 11000) throw conflict(`${document_type} already exists for this user`);
        throw err;
      }
    },

    async updateLocation(req, res) {
      const { bus_id, latitude, longitude, timestamp } = req.body;
      const bus = await Bus.findOne({ busId: bus_id }).lean();
      if (!bus) throw notFound('Bus not found');

      let source = 'admin';
      let schedule = null;
      if (roleRank(req.roleKey) < roleRank('operator')) {
        // Drivers may only report the bus they are scheduled on today.
        if (req.roleKey !== 'driver') throw forbidden();
        const today = todayInTz(config.APP_TIMEZONE);
        if (!(await Schedule.exists({ bus: bus._id, driver: req.user._id, date: today }))) throw forbidden('You are not assigned to this bus today');
        // Tie the position to the trip actually under way (started, not finished), never to an
        // arbitrary trip of the day (that put positions on finished or future trips).
        schedule = await Schedule.findOne({ bus: bus._id, driver: req.user._id, date: today, isReached: false, arrivalTime: { $lte: new Date() } })
          .sort({ arrivalTime: 1 })
          .lean();
        source = 'device';
      }
      if (!schedule) {
        // Operator/admin reports: attach the bus's trip in progress, if any.
        schedule = await Schedule.findOne({ bus: bus._id, date: todayInTz(config.APP_TIMEZONE), isReached: false, arrivalTime: { $lte: new Date() } })
          .sort({ arrivalTime: 1 })
          .lean();
      }
      const recordedAt = timestamp === undefined ? new Date() : new Date(timestamp);
      const loc = await recordLocation({ bus, lat: latitude, lng: longitude, recordedAt, source, schedule }, config);
      res.json({ message: 'Location updated', ...serializeLocation(loc, config) });
    },

    async getLocation(req, res) {
      const wanted = req.validatedQuery?.schedule_id;
      const loc = await BusLocation.findOne({ busId: req.params.bus_id }).populate('schedule', 'scheduleId isReached status').lean();
      if (!wanted) {
        // Legacy contract (no schedule_id): 404 when the bus has never reported a position.
        if (!loc) throw notFound('No location found');
        return res.json(serializeLocation(loc, config));
      }

      // Trip-scoped read. 404 only when the trip itself doesn't exist (for this bus): a
      // permanent answer. A real trip without a position yet is an empty result: 200 with
      // location null and the trip's own state, so a client can tell "not departed" from
      // "not found" instead of retrying a 404 forever.
      const trip = await Schedule.findOne({ scheduleId: wanted }, { scheduleId: 1, bus: 1, isReached: 1, status: 1, currentIndex: 1, arrivalTime: 1, departureTime: 1 }).populate('bus', 'busId').lean();
      if (!trip || trip.bus?.busId !== req.params.bus_id) {
        throw new AppError(404, 'TRIP_NOT_FOUND', 'No such trip for this bus');
      }
      const body = loc ? serializeLocation(loc, config) : null;
      if (body && body.schedule_id === wanted) return res.json(body);
      return res.json({
        bus_id: req.params.bus_id,
        schedule_id: wanted,
        location: null,
        trip_status: trip.status,
        trip_completed: Boolean(trip.isReached),
        trip_started: (trip.currentIndex || 0) > 0,
        lifecycle: tripLifecycle(trip, new Date()),
      });
    },

    // Why positions may not be moving: worker liveness, simulation on/off, last tick, last error.
    async trackingStatus(_req, res) {
      res.set('Cache-Control', 'no-store');
      res.json(await readTrackingStatus(config));
    },

    async getRoute(req, res) {
      const p = req.params;
      const geometry = await ctx.geo.getRouteGeometry({ lat: p.start_lat, lng: p.start_lng }, { lat: p.end_lat, lng: p.end_lng });
      const body = {
        routes: [
          {
            summary: { duration: geometry.durationSeconds ?? 0, distance: geometry.distanceMeters ?? 0 },
            geometry: { type: 'LineString', coordinates: geometry.coordinates },
          },
        ],
        provider: geometry.provider,
      };
      if (geometry.provider === 'fallback') body.warning = 'route_fallback_used';
      res.json(body);
    },

    async submitFeedback(req, res) {
      const fb = await Feedback.create({
        feedbackId: await nextSeq('feedback'),
        user: req.user._id,
        email: req.user.email,
        message: req.body.feedback,
        subject: req.body.subject || '',
        category: req.body.category || 'general',
        history: [{ at: new Date(), actor: req.user.userId, actorName: req.user.fullname, action: 'Submitted' }],
      });
      // Legacy fields kept; id/reference added for the "My feedback" view.
      res.json({
        message: 'Feedback submitted successfully',
        Feedback: fb.message,
        User: req.user.userId,
        email: req.user.email,
        id: fb.feedbackId,
        reference: `FB-${String(fb.feedbackId).padStart(6, '0')}`,
      });
    },

    async chatUsers(req, res) {
      const [users, unread] = await Promise.all([
        User.find({ _id: { $ne: req.user._id } }, { userId: 1, fullname: 1 }).sort({ fullname: 1 }).limit(1000).lean(),
        Notification.aggregate([
          { $match: { user: req.user._id, type: 'chat', isRead: false, sender: { $ne: null } } },
          { $group: { _id: '$sender', count: { $sum: 1 } } },
        ]),
      ]);
      const unreadBySender = new Map(unread.map((u) => [String(u._id), u.count]));
      // Email and internal ids are no longer exposed here (unused by the UI; privacy).
      res.json(users.map((u) => ({ user_uuid: u.userId, fullname: u.fullname, unread_messages: unreadBySender.get(String(u._id)) || 0 })));
    },

    async notifications(req, res) {
      const { limit, skip } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 500 });
      const list = await Notification.find({ user: req.user._id })
        .sort({ createdAt: -1, notificationId: -1 })
        .skip(skip)
        .limit(limit)
        .populate('sender', 'userId')
        .lean();
      // sender_id lets the UI open the chat with whoever sent a "chat" notification.
      res.json(list.map((n) => ({ ...serializeNotification(n, tz), ...(n.sender ? { sender_id: n.sender.userId } : {}) })));
    },

    async markRead(req, res) {
      // Scoped to the caller: the legacy endpoint let anyone mark anyone's notification.
      const r = await Notification.updateOne({ notificationId: req.params.notif_id, user: req.user._id }, { $set: { isRead: true } });
      if (!r.matchedCount) throw notFound('Notification not found');
      res.json({ message: 'Marked as read' });
    },

    async markAllRead(req, res) {
      const r = await Notification.updateMany({ user: req.user._id, isRead: false }, { $set: { isRead: true } });
      res.json({ message: r.modifiedCount ? 'All notifications marked as read' : 'No unread notifications' });
    },
  };
}
