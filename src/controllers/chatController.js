import { z } from 'zod';
import { ChatMessage } from '../models/index.js';
import { conversationKey } from '../services/realtime.js';
import { parsePagination } from '../utils/pagination.js';

export const schemas = {
  historyParams: z.object({ other_user_id: z.string().uuid('Invalid user id') }),
};

export const serializeMessage = (m) => ({
  message_id: m.messageId,
  sender_id: m.senderUserId,
  receiver_id: m.receiverUserId,
  msg: m.message,
  timestamp: new Date(m.createdAt).toISOString(),
});

export function createChatController() {
  return {
    // Only the caller's own conversation with other_user_id is ever returned.
    async history(req, res) {
      const { limit } = parsePagination(req.query, { defaultLimit: 200, maxLimit: 1000 });
      const key = conversationKey(req.user.userId, req.params.other_user_id);
      const latest = await ChatMessage.find({ conversationKey: key }).sort({ createdAt: -1, _id: -1 }).limit(limit).lean();
      res.json(latest.reverse().map(serializeMessage));
    },
  };
}
