import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Bus, DriverDocument, Feedback, Route, Schedule, Session, User } from '../models/index.js';
import { can, roleDisplayName, roleRank } from '../services/roles.js';
import { extractBearer, authenticateToken } from '../services/tokens.js';
import { parsePagination } from '../utils/pagination.js';
import { formatDateOnly, formatLegacy } from '../utils/time.js';
import { forbidden, notFound, unauthorized } from '../utils/errors.js';
import { routeFields } from './busController.js';

export const schemas = {
  docParam: z.object({ doc_id: z.coerce.number().int().positive() }),
  fileParam: z.object({ filename: z.string().regex(/^doc-\d+$/, 'Invalid file reference') }),
  fileQuery: z.object({
    exp: z.coerce.number().int().optional(),
    u: z.string().uuid().optional(),
    sig: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }),
};

export function createDataController(ctx) {
  const { config, storage } = ctx;
  const tz = config.APP_TIMEZONE;

  // Download links are opened via <a href> in a new tab, which cannot send the
  // Authorization header, so /data/get_documents hands out short-lived links signed for
  // the requesting user. Access is re-checked against that user on download.
  const sign = (docId, exp, userUuid) =>
    createHmac('sha256', config.JWT_SECRET).update(`doc-download:${docId}:${exp}:${userUuid}`).digest('hex');

  const canReviewDocuments = async (user) =>
    roleRank(user.roleKey) >= roleRank('operator') && (await can(user.roleKey, 'Uploded_documents'));

  return {
    async dashboard(req, res) {
      const now = new Date();
      const privileged = await can(req.roleKey, 'active_users');
      const { limit } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 1000 });
      // Clamped to 1..500: a negative value used to reach $limit and fail with a 500.
      const activeLimit = Math.min(Math.max(Number.parseInt(req.query.active_limit, 10) || 50, 1), 500);
      const activeFilter = { revokedAt: null, expiresAt: { $gt: now } };

      const [totalUsers, totalDrivers, totalBuses, recentUsers, activeUserIds, activeRows] = await Promise.all([
        User.countDocuments(),
        User.countDocuments({ roleKey: 'driver' }),
        Bus.countDocuments(),
        User.find({}, { userId: 1, fullname: 1, email: 1, createdAt: 1 }).sort({ createdAt: -1 }).limit(limit).lean(),
        Session.distinct('user', activeFilter),
        privileged
          ? Session.aggregate([
              { $match: activeFilter },
              { $sort: { loginAt: -1 } },
              { $group: { _id: '$user', s: { $first: '$$ROOT' } } },
              { $replaceRoot: { newRoot: '$s' } },
              { $sort: { loginAt: -1 } },
              { $limit: activeLimit },
            ])
          : [],
      ]);

      // Non-privileged roles (e.g. passengers) only get registration dates for the
      // dashboard chart, not other users' names and emails.
      const users = recentUsers.map((u) =>
        privileged
          ? { id: u.userId, fullname: u.fullname, email: u.email, created_date: formatDateOnly(u.createdAt, tz) }
          : { created_date: formatDateOnly(u.createdAt, tz) },
      );
      const activeUsers = activeRows.map((s) => ({
        id: s.userId,
        login_time: formatLegacy(s.loginAt, tz),
        fullname: s.fullname,
        email: s.email,
        role: roleDisplayName(s.roleKey),
      }));

      res.json({
        users,
        total_users: totalUsers,
        total_active_users: activeUserIds.length,
        active_users: activeUsers,
        total_driver: totalDrivers,
        total_drivers: totalDrivers,
        total_buses: totalBuses,
      });
    },

    async totalRoutes(req, res) {
      const { limit, skip } = parsePagination(req.query, { defaultLimit: 200, maxLimit: 2000 });
      const [total, completed, schedules] = await Promise.all([
        Schedule.countDocuments(),
        Schedule.countDocuments({ isReached: true }),
        Schedule.find()
          .sort({ arrivalTime: -1 })
          .skip(skip)
          .limit(limit)
          .populate('route', 'routeId')
          .populate('bus', 'busId')
          .populate('driver', 'userId')
          .populate('stop', 'stopId')
          .lean(),
      ]);
      res.json({
        total_routes: total,
        route_completed: completed,
        schedules: schedules.map((s) => ({
          schedule_id: s.scheduleId,
          route_id: s.route?.routeId ?? null,
          bus_id: s.bus?.busId ?? null,
          driver_id: s.driver?.userId ?? null,
          stop_id: s.stop?.stopId ?? null,
          arrival_time: formatLegacy(s.arrivalTime, tz),
          departure_time: formatLegacy(s.departureTime, tz),
          status: s.status,
          current_index: s.currentIndex,
          date: s.date,
          is_reached: Boolean(s.isReached),
        })),
      });
    },

    async listRoutes(req, res) {
      const { limit, skip } = parsePagination(req.query, { defaultLimit: 1000, maxLimit: 2000 });
      const routes = await Route.find().sort({ routeId: 1 }).skip(skip).limit(limit).lean();
      res.json(routes.map(routeFields));
    },

    async listDocuments(req, res) {
      if (!(await canReviewDocuments(req.user))) throw forbidden();
      const { limit, skip } = parsePagination(req.query, { defaultLimit: 200, maxLimit: 1000 });
      const docs = await DriverDocument.find().sort({ uploadTime: -1 }).skip(skip).limit(limit).lean();
      const exp = Math.floor(Date.now() / 1000) + config.DOWNLOAD_LINK_TTL_SECONDS;
      const viewer = req.user.userId;
      const documents = docs.map((d) => ({
        id: d.docId,
        driver_id: d.userId,
        document_name: d.documentType,
        document_path: `doc-${d.docId}?exp=${exp}&u=${viewer}&sig=${sign(d.docId, exp, viewer)}`,
        uploaded_at: formatLegacy(d.uploadTime, tz),
        status: d.isVerified ? 'verified' : d.isRejected ? 'rejected' : 'pending',
        is_verified: Boolean(d.isVerified),
        is_rejected: Boolean(d.isRejected),
        expiry_date: d.expiryDate ? formatDateOnly(d.expiryDate, 'UTC') : null,
        file_missing: Boolean(d.fileMissing),
      }));
      res.json({ total_documents: await DriverDocument.countDocuments(), documents });
    },

    async downloadDocument(req, res) {
      const docId = Number(req.params.filename.slice(4));
      const q = req.validatedQuery;

      let viewer;
      const bearer = extractBearer(req.headers.authorization);
      if (bearer) {
        viewer = (await authenticateToken(bearer, config)).user;
        if (viewer.mustChangePassword) throw forbidden('Choose a new password before continuing');
      } else if (q.sig && q.exp && q.u) {
        const expected = Buffer.from(sign(docId, q.exp, q.u), 'hex');
        const given = Buffer.from(q.sig, 'hex');
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw forbidden('Invalid download link');
        if (q.exp < Math.floor(Date.now() / 1000)) throw forbidden('Download link expired; reload the documents page');
        viewer = await User.findOne({ userId: q.u }).lean();
        if (!viewer) throw forbidden('Invalid download link');
      } else {
        throw unauthorized('Authorization required');
      }

      const doc = await DriverDocument.findOne({ docId }).lean();
      if (!doc) throw notFound('File not found');
      const isOwner = String(doc.user) === String(viewer._id);
      if (!isOwner && !(await canReviewDocuments(viewer))) throw forbidden();

      const file = await storage.get(doc.storageKey);
      if (!file) throw notFound('File not found');
      const ext = doc.storageKey.split('.').pop();
      res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${doc.documentType.replace(/[^\w .-]/g, '_')}.${ext}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (file.size) res.setHeader('Content-Length', String(file.size));
      file.stream.on('error', () => res.destroy());
      file.stream.pipe(res);
    },

    review: (verified) => async (req, res) => {
      if (!(await canReviewDocuments(req.user))) throw forbidden();
      const doc = await DriverDocument.findOneAndUpdate(
        { docId: req.params.doc_id },
        { $set: { isVerified: verified, isRejected: !verified, reviewedBy: req.user._id, reviewedAt: new Date() } },
        { new: true },
      );
      if (!doc) throw notFound('Document not found');
      res.json({ message: verified ? 'Document verified' : 'Document rejected' });
    },

    async listFeedback(req, res) {
      if (roleRank(req.roleKey) < roleRank('operator') || !(await can(req.roleKey, 'Feedbacks'))) throw forbidden();
      const { limit, skip } = parsePagination(req.query, { defaultLimit: 500, maxLimit: 1000 });
      const rows = await Feedback.find().sort({ createdAt: -1 }).skip(skip).limit(limit).populate('user', 'fullname').lean();
      res.json(
        rows.map((f) => ({
          user_name: f.user?.fullname ?? 'Unknown',
          email: f.email,
          feedback: f.message,
          created_at: formatLegacy(f.createdAt, tz),
        })),
      );
    },
  };
}
