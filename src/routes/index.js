import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { authenticate, authenticateApplicant, optionalAuthenticate, requireMinRole, requirePermission, requireRoles } from '../middleware/auth.js';
import { validate } from '../middleware/common.js';
import { can } from '../services/roles.js';
import { forbidden, notImplemented } from '../utils/errors.js';
import { pingMongo } from '../db.js';
import {
  changePasswordSchema, createAuthController, forgotPasswordSchema, loginSchema, resetPasswordSchema, signupSchema,
} from '../controllers/authController.js';
import { createViewController, schemas as viewSchemas } from '../controllers/viewController.js';
import { createBusController, schemas as busSchemas } from '../controllers/busController.js';
import { createDataController, schemas as dataSchemas } from '../controllers/dataController.js';
import { createChatController, schemas as chatSchemas } from '../controllers/chatController.js';
import { createPermissionsController, schemas as permSchemas } from '../controllers/permissionsController.js';
import { createOnboardingController, schemas as onbSchemas } from '../controllers/onboardingController.js';
import { createPublicController, schemas as pubSchemas } from '../controllers/publicController.js';
import { createFeedbackController, schemas as fbSchemas } from '../controllers/feedbackController.js';

const requireAnyPermission = (...keys) => async (req, _res, next) => {
  for (const k of keys) if (await can(req.roleKey, k)) return next();
  return next(forbidden());
};

export function buildRouter(ctx, limiters) {
  const { config } = ctx;
  const auth = authenticate(config);
  const authPendingPasswordOk = authenticate(config, { allowPendingPasswordChange: true });
  const router = Router();

  const authC = createAuthController(ctx);
  const viewC = createViewController(ctx);
  const busC = createBusController(ctx);
  const dataC = createDataController(ctx);
  const chatC = createChatController();
  const permC = createPermissionsController();
  const onbC = createOnboardingController(ctx);
  const pubC = createPublicController(ctx);
  const fbC = createFeedbackController(ctx);
  const applicant = authenticateApplicant(config);

  // Profile PUT accepts JSON or multipart (editProfile.jsx sends FormData with an optional
  // "profileimg" file). Profile images are not stored, so files are dropped.
  const formFieldsOnly = multer({ limits: { fields: 30, fieldSize: 10_000 }, fileFilter: (_r, _f, cb) => cb(null, false) }).any();
  const documentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1, fields: 10 } }).single('file');

  // ---------------- health ----------------
  router.get('/', (_req, res) => res.type('text/plain').send('Backend running successfully'));
  // Liveness (no database call): what Render's health check and keep-alive pings hit.
  router.get('/health/live', (_req, res) => res.set('Cache-Control', 'no-store').json({ status: 'ok' }));
  const ready = async (_req, res) => {
    const mongo = await pingMongo();
    res.status(mongo ? 200 : 503).json({ status: mongo ? 'ready' : 'not_ready', checks: { mongo } });
  };
  router.get('/health/ready', ready);
  router.get('/healthz', ready);

  // ---------------- /auth ----------------
  const a = Router();
  a.post('/login', limiters.login, validate({ body: loginSchema }), authC.login);
  a.post('/logout', authPendingPasswordOk, authC.logout);
  a.post('/forgot_password', limiters.passwordReset, validate({ body: forgotPasswordSchema }), authC.forgotPassword);
  a.post('/reset_password', limiters.passwordReset, validate({ body: resetPasswordSchema }), authC.resetPassword);
  a.post('/change_password', authPendingPasswordOk, limiters.passwordChange, validate({ body: changePasswordSchema }), authC.changePassword);
  a.post('/signup', limiters.signup, optionalAuthenticate(config), validate({ body: signupSchema }), authC.signup);
  a.get('/profile', auth, viewC.getProfile);
  a.put('/profile', auth, formFieldsOnly, validate({ body: viewSchemas.profileUpdate }), viewC.updateProfile);
  a.post('/verify_otp', limiters.otp, authC.verifyOtp);
  a.get('/signup_options', onbC.signupOptions);
  a.post('/signup/send_code', limiters.signupCode, validate({ body: onbSchemas.sendCode }), onbC.sendCode);
  a.post('/signup/verify_code', limiters.signupCode, validate({ body: onbSchemas.verifyCode }), onbC.verifyCode);
  router.use('/auth', a);

  // ---------------- /public (no account needed) ----------------
  const pub = Router();
  pub.get('/routes', validate({ query: pubSchemas.routesQuery }), pubC.routes);
  pub.get('/departures', validate({ query: pubSchemas.departuresQuery }), pubC.departures);
  router.use('/public', pub);

  // ---------------- /onboarding (driver & operator applications) ----------------
  const applicationUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1, fields: 5 } }).single('file');
  const o = Router();
  o.post('/applications', limiters.signupCode, validate({ body: onbSchemas.createApplication }), onbC.createApplication);
  o.get('/me', applicant, onbC.me);
  o.post('/me/documents', applicant, limiters.application, applicationUpload, validate({ body: onbSchemas.uploadBody }), onbC.uploadDocument);
  o.get('/me/documents/:type/file', applicant, validate({ params: onbSchemas.docParam }), onbC.myDocumentFile);
  o.post('/me/submit', applicant, limiters.application, onbC.submit);
  // Reviewers (normal accounts). Fine-grained rights are checked per application.
  o.get('/applications', auth, requireMinRole('operator'), validate({ query: onbSchemas.listQuery }), onbC.list);
  o.get('/applications/:id', auth, requireMinRole('operator'), validate({ params: onbSchemas.appParam }), onbC.detail);
  o.get('/applications/:id/documents/:type/file', auth, requireMinRole('operator'), validate({ params: onbSchemas.appDocParam }), onbC.reviewerDocumentFile);
  o.post('/applications/:id/documents/:type/review', auth, requireMinRole('operator'), validate({ params: onbSchemas.appDocParam, body: onbSchemas.reviewDoc }), onbC.reviewDocument);
  o.post('/applications/:id/request_changes', auth, requireMinRole('operator'), validate({ params: onbSchemas.appParam, body: onbSchemas.comment }), onbC.requestChanges);
  o.post('/applications/:id/reject', auth, requireMinRole('admin'), validate({ params: onbSchemas.appParam, body: onbSchemas.reject }), onbC.reject);
  o.post('/applications/:id/approve', auth, requireMinRole('admin'), validate({ params: onbSchemas.appParam, body: onbSchemas.approve }), onbC.approve);
  router.use('/onboarding', o);

  // ---------------- /feedback (conversations) ----------------
  // Submitters see only their own feedback; staff rights are checked in the controller
  // (operator+ with the "Feedbacks" permission, as for the existing inbox).
  const f = Router();
  f.get('/mine', auth, requirePermission('Feedback'), fbC.mine);
  f.get('/mine/:id', auth, requirePermission('Feedback'), validate({ params: fbSchemas.idParam }), fbC.mineDetail);
  f.get('/', auth, validate({ query: fbSchemas.listQuery }), fbC.list);
  f.get('/:id', auth, validate({ params: fbSchemas.idParam }), fbC.detail);
  f.post('/:id/replies', auth, limiters.feedbackReply, validate({ params: fbSchemas.idParam, body: fbSchemas.reply }), fbC.reply);
  f.post('/:id/replies/:reply_id/retry_email', auth, limiters.feedbackReply, validate({ params: fbSchemas.replyParam }), fbC.retryEmail);
  f.patch('/:id', auth, validate({ params: fbSchemas.idParam, body: fbSchemas.update }), fbC.update);
  router.use('/feedback', f);

  // ---------------- /view ----------------
  const v = Router();
  v.get('/user_details', auth, requirePermission('users'), viewC.userDetails);
  v.get('/driver_details', auth, requirePermission('drivers'), viewC.driverDetails);
  v.get('/profile', auth, viewC.getProfile);
  v.put('/profile', auth, formFieldsOnly, validate({ body: viewSchemas.profileUpdate }), viewC.updateProfile);
  v.post('/delete', auth, validate({ body: viewSchemas.userUuidBody }), viewC.deleteUser);
  v.post('/edit_user_details', auth, validate({ body: viewSchemas.editUser }), viewC.editUser);
  v.get('/password_reset_requests', auth, requireMinRole('admin'), viewC.passwordResetRequests);
  v.post('/reset_user_password', auth, validate({ body: viewSchemas.userUuidBody }), viewC.resetUserPassword);
  v.post(
    '/upload/:user_id',
    auth,
    limiters.upload,
    validate({ params: viewSchemas.uploadParams }),
    documentUpload,
    validate({ body: viewSchemas.uploadBody }),
    viewC.uploadDocument,
  );
  v.post('/update_location', auth, validate({ body: viewSchemas.updateLocation }), viewC.updateLocation);
  v.get('/tracking_status', auth, requireAnyPermission('live_tracking', 'bus_tracking'), viewC.trackingStatus);
  v.get('/get_location/:bus_id', auth, requirePermission('bus_tracking'), validate({ params: viewSchemas.busIdParam, query: viewSchemas.locationQuery }), viewC.getLocation);
  v.get(
    '/api/get_route/:start_lat/:start_lng/:end_lat/:end_lng',
    auth,
    limiters.geo,
    validate({ params: viewSchemas.routeParams }),
    viewC.getRoute,
  );
  v.post('/submit_feedback', auth, requirePermission('Feedback'), validate({ body: viewSchemas.feedback }), viewC.submitFeedback);
  v.get('/chat_users', auth, requirePermission('chat'), viewC.chatUsers);
  v.get('/notifications', auth, viewC.notifications);
  v.post('/notifications/mark_read/:notif_id', auth, validate({ params: viewSchemas.notifParam }), viewC.markRead);
  v.post('/notifications/mark_all_read', auth, viewC.markAllRead);
  v.post('/notifications/mark_read_all', auth, viewC.markAllRead); // alias used by Notification.jsx
  router.use('/view', v);

  // ---------------- /bus ----------------
  const b = Router();
  b.post('/bus_route', auth, requireMinRole('operator'), requirePermission('create_routes'), validate({ body: busSchemas.busRoute }), busC.createRoute);
  b.post('/get_routes', auth, requireAnyPermission('all_routes', 'live_tracking'), validate({ body: busSchemas.searchRoutes }), busC.searchRoutes);
  b.get('/geocode', auth, limiters.geo, validate({ query: busSchemas.geocode }), busC.geocode);
  b.get('/schedules', auth, requireAnyPermission('dashboard', 'bus_schedule'), validate({ query: busSchemas.schedulesQuery }), busC.listSchedules);
  b.post('/schedules', auth, requireMinRole('operator'), requirePermission('bus_schedule'), validate({ body: busSchemas.createSchedule }), busC.createSchedule);
  b.get('/get_all_buses', auth, requireAnyPermission('dashboard', 'register_bus'), busC.listBuses);
  b.post('/register_bus', auth, requireMinRole('operator'), requirePermission('register_bus'), validate({ body: busSchemas.registerBus }), busC.registerBus);
  router.use('/bus', b);

  // ---------------- /data ----------------
  const d = Router();
  d.get('/get_data', auth, requireAnyPermission('dashboard', 'active_users'), dataC.dashboard);
  d.get('/total_routes', auth, requirePermission('dashboard'), dataC.totalRoutes);
  d.get('/get_routes', auth, requirePermission('dashboard'), dataC.listRoutes); // Total_routes.jsx
  d.get('/get_documents', auth, dataC.listDocuments);
  d.get('/uploads/:filename', validate({ params: dataSchemas.fileParam, query: dataSchemas.fileQuery }), dataC.downloadDocument);
  d.post('/verify_document/:doc_id', auth, validate({ params: dataSchemas.docParam }), dataC.review(true));
  d.post('/reject_document/:doc_id', auth, validate({ params: dataSchemas.docParam }), dataC.review(false));
  d.get('/get_feedback', auth, dataC.listFeedback);
  router.use('/data', d);

  // ---------------- /chat ----------------
  const c = Router();
  c.get('/history/:other_user_id', auth, requirePermission('chat'), validate({ params: chatSchemas.historyParams }), chatC.history);
  router.use('/chat', c);

  // ---------------- /permissions ----------------
  const p = Router();
  p.get('/roles', auth, requireRoles('superadmin'), permC.roles);
  p.get('/matrix', auth, requireRoles('superadmin'), permC.matrix);
  p.put('/matrix', auth, requireRoles('superadmin'), validate({ body: permSchemas.matrixUpdate }), permC.updateMatrix);
  p.get('/my', auth, permC.my);
  router.use('/permissions', p);

  // ---------------- /chatbot ----------------
  // The Flask chatbot module was removed upstream (website/chatbot.py); not ported.
  router.post('/chatbot/chat', auth, validate({ body: z.object({ message: z.string().max(4000).optional() }).passthrough() }), () => {
    throw notImplemented('Chatbot is not available on this server');
  });

  return router;
}
