import { Notification, User, nextSeq } from '../models/index.js';
import { emitTo, userRoom } from './realtime.js';
import { formatLegacy } from '../utils/time.js';

export const serializeNotification = (n, tz) => ({
  id: n.notificationId,
  message: n.message,
  type: n.type,
  timestamp: formatLegacy(n.createdAt, tz),
  is_read: Boolean(n.isRead),
  ...(n.link ? { link: n.link } : {}),
});

export async function createNotification({ user, message, type = 'info', sender = null, link = null }, { tz, logger }) {
  const doc = await Notification.create({
    notificationId: await nextSeq('notifications'),
    user: user._id,
    message: message.slice(0, 250),
    type,
    sender: sender?._id ?? null,
    link,
  });
  const payload = serializeNotification(doc, tz);
  if (sender) payload.sender_id = sender.userId;
  try {
    emitTo(userRoom(user.userId), 'new_notification', payload);
  } catch (err) {
    logger?.warn({ err: { message: err.message } }, 'Notification emit failed');
  }
  return doc;
}

// Port of website/utils.py notify_admins(): failures are logged, never thrown, so the
// primary action (signup, route creation) is not rolled back by a notification error.
export async function notifyAdmins(message, type, ctx) {
  try {
    const admins = await User.find({ roleKey: { $in: ['superadmin', 'admin'] } }, { userId: 1 }).limit(200).lean();
    for (const admin of admins) await createNotification({ user: admin, message, type }, ctx);
  } catch (err) {
    ctx.logger?.warn({ err: { message: err.message } }, 'notifyAdmins failed');
  }
}
