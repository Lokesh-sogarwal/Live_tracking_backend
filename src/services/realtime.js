// Thin indirection so services can emit Socket.IO events without importing the server.
// In the worker process no io is registered and emits are no-ops.
let io = null;

export const setIo = (instance) => {
  io = instance;
};

export const userRoom = (userUuid) => `user_${userUuid}`;
export const busRoom = (busId) => `bus_${busId}`;
export const conversationKey = (a, b) => [String(a), String(b)].sort().join('_');

// Returns whether anything was emitted (false in processes without Socket.IO, e.g. the worker).
export function emitTo(rooms, event, payload) {
  if (!io) return false;
  const list = Array.isArray(rooms) ? rooms : [rooms];
  // A single emit across several rooms is delivered once per socket.
  list.reduce((op, room) => op.to(room), io).emit(event, payload);
  return true;
}
