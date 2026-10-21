import { Server } from 'socket.io';
import { z } from 'zod';
import { Bus, BusLocation, ChatMessage, User } from '../models/index.js';
import { serializeLocation } from '../services/locations.js';
import { authenticateToken, extractBearer } from '../services/tokens.js';
import { can, normalizeRole } from '../services/roles.js';
import { createNotification } from '../services/notifications.js';
import { busRoom, conversationKey, emitTo, setIo, userRoom } from '../services/realtime.js';
import { serializeMessage } from '../controllers/chatController.js';
import { corsOriginCheck } from '../app.js';
import { markEmitted, startLocationRelay } from '../services/locationRelay.js';

// Event contract (docs/API_CONTRACT.md#socketio):
//   chat:join  / join            { otherUserId | receiver_id }               -> ack { ok }
//   chat:send  / send_message    { receiverId | receiver_id, message | msg, clientMessageId? }
//                                -> ack { ok, message_id, timestamp }; broadcasts "message" + "chat:message"
//   chat:leave / leave           { otherUserId | receiver_id }
//   join_notifications           { user_uuid } (own uuid only; the personal room is joined on connect)
//   bus:subscribe / bus:unsubscribe { busId }   -> ack, then the current position (if any) and every
//                                                 later position as "bus:location" (incl. worker-written)
// sender_id is never trusted: identity always comes from the handshake token.

const uuid = z.string().uuid();

function slidingWindowLimiter(max, windowMs) {
  const hits = [];
  return () => {
    const now = Date.now();
    while (hits.length && hits[0] <= now - windowMs) hits.shift();
    if (hits.length >= max) return false;
    hits.push(now);
    return true;
  };
}

export function createSocketServer(httpServer, ctx) {
  const { config, logger } = ctx;
  const io = new Server(httpServer, {
    cors: { origin: corsOriginCheck(config.frontendOrigins), credentials: true },
    maxHttpBufferSize: 64 * 1024,
    connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000, skipMiddlewares: false },
  });
  setIo(io);
  // Delivers positions written by other processes (e.g. the simulation worker).
  const relay = startLocationRelay(io, { config, logger, intervalMs: config.LOCATION_RELAY_MS });
  const closeIo = io.close.bind(io);
  io.close = (fn) => {
    relay.stop();
    return closeIo(fn);
  };

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token || extractBearer(socket.handshake.headers?.authorization);
    if (!token) return next(new Error('unauthorized'));
    try {
      const { user, jti } = await authenticateToken(token, config);
      if (user.mustChangePassword) return next(new Error('password_change_required'));
      socket.data.user = { _id: user._id, userId: user.userId, fullname: user.fullname, roleKey: normalizeRole(user.roleKey) };
      socket.data.jti = jti;
      return next();
    } catch {
      return next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const me = socket.data.user;
    const log = logger.child({ socketId: socket.id, userId: me.userId });
    socket.join(userRoom(me.userId));
    const allowSend = slidingWindowLimiter(config.CHAT_RATE_LIMIT_PER_10S, 10_000);
    const allowJoin = slidingWindowLimiter(30, 10_000);

    const fail = (ack, error) => {
      socket.emit('error', { msg: error });
      if (typeof ack === 'function') ack({ ok: false, error });
    };

    const resolvePeer = async (raw) => {
      const parsed = uuid.safeParse(raw);
      if (!parsed.success || parsed.data === me.userId) return null;
      return User.findOne({ userId: parsed.data }, { userId: 1, fullname: 1 }).lean();
    };

    const onJoin = async (data, ack) => {
      try {
        if (!allowJoin()) return fail(ack, 'Rate limit exceeded');
        if (data?.sender_id && data.sender_id !== me.userId) return fail(ack, 'sender_id does not match the authenticated user');
        if (!(await can(me.roleKey, 'chat'))) return fail(ack, 'Not allowed to use chat');
        const peer = await resolvePeer(data?.otherUserId ?? data?.receiver_id);
        if (!peer) return fail(ack, 'Invalid chat partner');
        // The room is derived from the authenticated user + a real peer, so a client can
        // only ever join conversations it is a participant of.
        socket.join(conversationKey(me.userId, peer.userId));
        if (typeof ack === 'function') ack({ ok: true });
      } catch (err) {
        log.warn({ err: { message: err.message } }, 'join failed');
        fail(ack, 'Server error');
      }
      return undefined;
    };

    const onLeave = (data) => {
      const other = data?.otherUserId ?? data?.receiver_id;
      if (uuid.safeParse(other).success) socket.leave(conversationKey(me.userId, other));
    };

    const onSend = async (data, ack) => {
      try {
        if (!allowSend()) return fail(ack, 'Rate limit exceeded');
        if (data?.sender_id && data.sender_id !== me.userId) return fail(ack, 'sender_id does not match the authenticated user');
        const text = typeof (data?.message ?? data?.msg) === 'string' ? (data.message ?? data.msg).trim() : '';
        if (!text) return fail(ack, 'Missing receiver_id/msg');
        if (text.length > config.CHAT_MAX_MESSAGE_LENGTH) return fail(ack, `Message exceeds ${config.CHAT_MAX_MESSAGE_LENGTH} characters`);
        const clientMessageId = data?.clientMessageId ?? data?.client_message_id;
        if (clientMessageId !== undefined && (typeof clientMessageId !== 'string' || clientMessageId.length > 100)) {
          return fail(ack, 'Invalid clientMessageId');
        }
        if (!(await can(me.roleKey, 'chat'))) return fail(ack, 'Not allowed to use chat');
        const peer = await resolvePeer(data?.receiverId ?? data?.receiver_id);
        if (!peer) return fail(ack, 'Invalid user ID');

        const key = conversationKey(me.userId, peer.userId);
        let doc;
        let duplicate = false;
        try {
          // Persist first; only a stored message is acknowledged or broadcast.
          doc = await ChatMessage.create({
            sender: me._id,
            receiver: peer._id,
            senderUserId: me.userId,
            receiverUserId: peer.userId,
            conversationKey: key,
            message: text,
            clientMessageId,
          });
        } catch (err) {
          if (err.code !== 11000 || !clientMessageId) throw err;
          // Client retry after a lost ack: return the stored message, do not broadcast again.
          doc = await ChatMessage.findOne({ senderUserId: me.userId, clientMessageId }).lean();
          duplicate = true;
        }

        const payload = serializeMessage(doc);
        if (!duplicate) {
          socket.join(key);
          emitTo([key, userRoom(peer.userId)], 'message', payload);
          emitTo([key, userRoom(peer.userId)], 'chat:message', payload);
          await createNotification(
            { user: peer, message: `New message from ${me.fullname}`, type: 'chat', sender: me },
            { tz: config.APP_TIMEZONE, logger: log },
          ).catch((err) => log.warn({ err: { message: err.message } }, 'chat notification failed'));
        }
        if (typeof ack === 'function') ack({ ok: true, message_id: payload.message_id, timestamp: payload.timestamp, duplicate });
      } catch (err) {
        log.error({ err: { message: err.message } }, 'send_message failed');
        fail(ack, 'Database error');
      }
      return undefined;
    };

    const onJoinNotifications = (data, ack) => {
      // The personal room is joined automatically; requests for another user's room are refused.
      if (data?.user_uuid && data.user_uuid !== me.userId) return fail(ack, 'Cannot join another user\'s notifications');
      socket.join(userRoom(me.userId));
      if (typeof ack === 'function') ack({ ok: true });
      return undefined;
    };

    const onBusSubscribe = async (data, ack) => {
      try {
        const busId = Number(data?.busId ?? data?.bus_id);
        if (!Number.isInteger(busId) || busId <= 0) return fail(ack, 'Invalid busId');
        if (!(await can(me.roleKey, 'bus_tracking'))) return fail(ack, 'Not allowed to track buses');
        if (!(await Bus.exists({ busId }))) return fail(ack, 'Bus not found');
        socket.join(busRoom(busId));
        if (typeof ack === 'function') ack({ ok: true });
        // Current position straight away, so a map can place the marker without waiting
        // for the next movement. The relay won't send this same position again.
        const current = await BusLocation.findOne({ busId }).populate('schedule', 'scheduleId isReached status').lean();
        if (current) {
          markEmitted(busId, current.recordedAt);
          socket.emit('bus:location', serializeLocation(current, config));
        }
      } catch {
        fail(ack, 'Server error');
      }
      return undefined;
    };

    socket.on('chat:join', onJoin);
    socket.on('join', onJoin);
    socket.on('chat:leave', onLeave);
    socket.on('leave', onLeave);
    socket.on('chat:send', onSend);
    socket.on('send_message', onSend);
    socket.on('join_notifications', onJoinNotifications);
    socket.on('bus:subscribe', onBusSubscribe);
    socket.on('bus:unsubscribe', (data) => socket.leave(busRoom(Number(data?.busId ?? data?.bus_id))));
  });

  return io;
}
