import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { io as connect } from 'socket.io-client';
import { ChatMessage, Notification } from '../src/models/index.js';
import { bearer, createBus, setupTestApp, startRealtime, userWithToken } from './helpers.js';

let t;
let rt;
let alice;
let bob;
let carol;
const sockets = [];

const open = (token, extra = {}) =>
  new Promise((resolve, reject) => {
    const s = connect(rt.url, { auth: token ? { token } : undefined, transports: ['websocket'], reconnection: false, forceNew: true, ...extra });
    sockets.push(s);
    s.on('connect', () => resolve(s));
    s.on('connect_error', (err) => reject(err));
  });
const emit = (s, event, data) => new Promise((resolve) => s.emit(event, data, resolve));
const next = (s, event, ms = 1500) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    s.once(event, (p) => {
      clearTimeout(timer);
      resolve(p);
    });
  });
const nothing = (s, event, ms = 300) =>
  new Promise((resolve, reject) => {
    const h = () => reject(new Error(`unexpected ${event}`));
    s.once(event, h);
    setTimeout(() => {
      s.off(event, h);
      resolve();
    }, ms);
  });

beforeAll(async () => {
  t = await setupTestApp('chat', { CHAT_RATE_LIMIT_PER_10S: '5', CHAT_MAX_MESSAGE_LENGTH: '50' });
  rt = await startRealtime(t.app, t.ctx);
  alice = await userWithToken(t.app, 'passenger');
  bob = await userWithToken(t.app, 'driver');
  carol = await userWithToken(t.app, 'passenger');
});
afterAll(async () => {
  sockets.forEach((s) => s.disconnect());
  await rt.stop();
  await t.close();
});

describe('socket authentication', () => {
  it('rejects connections without or with an invalid token', async () => {
    await expect(open(null)).rejects.toThrow(/unauthorized/);
    await expect(open('garbage')).rejects.toThrow(/unauthorized/);
  });

  it('rejects a token whose session was logged out', async () => {
    const u = await userWithToken(t.app, 'passenger');
    await request(t.app).post('/auth/logout').set(bearer(u.token));
    await expect(open(u.token)).rejects.toThrow(/unauthorized/);
  });

  it('accepts the token via the Authorization header too', async () => {
    const s = await open(null, { extraHeaders: { Authorization: `Bearer ${alice.token}` } });
    expect(s.connected).toBe(true);
  });
});

describe('chat', () => {
  it('persists before ack and delivers to the receiver (legacy event names)', async () => {
    const a = await open(alice.token);
    const b = await open(bob.token);
    expect(await emit(a, 'join', { sender_id: alice.user.userId, receiver_id: bob.user.userId })).toEqual({ ok: true });

    const received = next(b, 'message');
    const notif = next(b, 'new_notification');
    const ack = await emit(a, 'send_message', { sender_id: alice.user.userId, receiver_id: bob.user.userId, msg: 'hi bob' });
    expect(ack).toMatchObject({ ok: true, message_id: expect.any(String) });
    expect(await ChatMessage.findOne({ messageId: ack.message_id }).lean()).toMatchObject({ message: 'hi bob', senderUserId: alice.user.userId });
    expect(await received).toMatchObject({ sender_id: alice.user.userId, receiver_id: bob.user.userId, msg: 'hi bob' });
    expect(await notif).toMatchObject({ type: 'chat', sender_id: alice.user.userId });
    expect(await Notification.countDocuments({ user: bob.user._id, type: 'chat', isRead: false })).toBe(1);
  });

  it('supports the new chat:* events and idempotent clientMessageId retries', async () => {
    const a = await open(alice.token);
    const b = await open(bob.token);
    expect(await emit(a, 'chat:join', { otherUserId: bob.user.userId })).toEqual({ ok: true });
    const got = next(b, 'chat:message');
    const first = await emit(a, 'chat:send', { receiverId: bob.user.userId, message: 'retry me', clientMessageId: 'c-1' });
    await got;
    const extra = nothing(b, 'chat:message');
    const retry = await emit(a, 'chat:send', { receiverId: bob.user.userId, message: 'retry me', clientMessageId: 'c-1' });
    await extra;
    expect(retry).toMatchObject({ ok: true, duplicate: true, message_id: first.message_id });
    expect(await ChatMessage.countDocuments({ clientMessageId: 'c-1' })).toBe(1);
  });

  it('rejects sender impersonation', async () => {
    const c = await open(carol.token);
    const b = await open(bob.token);
    const silent = nothing(b, 'message');
    const ack = await emit(c, 'send_message', { sender_id: alice.user.userId, receiver_id: bob.user.userId, msg: 'I am alice' });
    await silent;
    expect(ack.ok).toBe(false);
    expect(await ChatMessage.countDocuments({ message: 'I am alice' })).toBe(0);
  });

  it('does not let a third party join or read another conversation', async () => {
    const c = await open(carol.token);
    const a = await open(alice.token);
    // Carol can only ever join rooms that include herself.
    expect(await emit(c, 'join', { sender_id: alice.user.userId, receiver_id: bob.user.userId })).toMatchObject({ ok: false });
    expect(await emit(c, 'join', { receiver_id: bob.user.userId })).toEqual({ ok: true });
    const leak = nothing(c, 'message');
    await emit(a, 'send_message', { receiver_id: bob.user.userId, msg: 'private' });
    await leak;

    const hist = await request(t.app).get(`/chat/history/${bob.user.userId}`).set(bearer(carol.token));
    expect(hist.status).toBe(200);
    expect(hist.body.map((m) => m.msg)).not.toContain('private');
    const own = await request(t.app).get(`/chat/history/${bob.user.userId}`).set(bearer(alice.token));
    expect(own.body.map((m) => m.msg)).toEqual(expect.arrayContaining(['hi bob', 'private']));
    expect((await request(t.app).get('/chat/history/not-a-uuid').set(bearer(alice.token))).status).toBe(400);
    expect((await request(t.app).get(`/chat/history/${bob.user.userId}`)).status).toBe(401);
  });

  it('refuses joining another user\'s notification room', async () => {
    const c = await open(carol.token);
    expect(await emit(c, 'join_notifications', { user_uuid: alice.user.userId })).toMatchObject({ ok: false });
    expect(await emit(c, 'join_notifications', { user_uuid: carol.user.userId })).toEqual({ ok: true });
  });

  it('validates message content, receiver and rate', async () => {
    const a = await open(alice.token);
    expect((await emit(a, 'send_message', { receiver_id: bob.user.userId, msg: '' })).ok).toBe(false);
    expect((await emit(a, 'send_message', { receiver_id: bob.user.userId, msg: 'x'.repeat(51) })).ok).toBe(false);
    expect((await emit(a, 'send_message', { receiver_id: 'nope', msg: 'hi' })).ok).toBe(false);
    expect((await emit(a, 'send_message', { receiver_id: alice.user.userId, msg: 'me' })).ok).toBe(false);
    // Rejected attempts count toward the budget, so measure the rate on a fresh socket.
    const fresh = await open(alice.token);
    const results = [];
    for (let i = 0; i < 7; i += 1) results.push((await emit(fresh, 'send_message', { receiver_id: carol.user.userId, msg: `m${i}` })).ok);
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(results.at(-1)).toBe(false);
  });

  it('chat_users exposes unread counts per sender without emails', async () => {
    const res = await request(t.app).get('/view/chat_users').set(bearer(bob.token));
    expect(res.status).toBe(200);
    const fromAlice = res.body.find((u) => u.user_uuid === alice.user.userId);
    expect(fromAlice.unread_messages).toBeGreaterThanOrEqual(1);
    expect(fromAlice).not.toHaveProperty('email');
    expect(res.body.find((u) => u.user_uuid === bob.user.userId)).toBeUndefined();
  });
});

describe('bus location events', () => {
  it('delivers bus:location to subscribed clients when a location is ingested', async () => {
    const admin = await userWithToken(t.app, 'admin');
    const bus = await createBus();
    const s = await open(alice.token);
    expect(await emit(s, 'bus:subscribe', { busId: bus.busId })).toEqual({ ok: true });
    expect((await emit(s, 'bus:subscribe', { busId: 999999 })).ok).toBe(false);
    const evt = next(s, 'bus:location');
    await request(t.app).post('/view/update_location').set(bearer(admin.token)).send({ bus_id: bus.busId, latitude: 12.97, longitude: 77.59 });
    expect(await evt).toMatchObject({ bus_id: bus.busId, latitude: 12.97, longitude: 77.59, is_stale: false });
  });
});
