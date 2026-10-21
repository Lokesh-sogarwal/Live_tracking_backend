import { JobLock } from '../models/index.js';

// Lease-based mutual exclusion stored in MongoDB. Only the lease holder runs jobs; if it
// dies, another worker takes over once the lease expires.
export async function acquireLease(name, owner, ttlMs) {
  const now = new Date();
  try {
    const doc = await JobLock.findOneAndUpdate(
      { _id: name, $or: [{ leaseUntil: { $lt: now } }, { owner }] },
      { $set: { owner, leaseUntil: new Date(now.getTime() + ttlMs) } },
      { upsert: true, new: true },
    ).lean();
    return doc?.owner === owner;
  } catch (err) {
    // Upsert collided with a lease held by someone else.
    if (err.code === 11000) return false;
    throw err;
  }
}

export async function releaseLease(name, owner) {
  await JobLock.updateOne({ _id: name, owner }, { $set: { leaseUntil: new Date(0) } });
}
