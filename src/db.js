import mongoose from 'mongoose';

mongoose.set('strictQuery', true);

export async function connectMongo(uri, logger) {
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  mongoose.connection.on('error', (err) => logger.error({ err: { message: err.message } }, 'MongoDB error'));

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 20,
  });
  logger.info({ db: mongoose.connection.name }, 'MongoDB connected');
  return mongoose.connection;
}

export async function disconnectMongo() {
  await mongoose.disconnect();
}

export function isMongoReady() {
  return mongoose.connection.readyState === 1;
}

export async function pingMongo() {
  if (!isMongoReady()) return false;
  try {
    await mongoose.connection.db.admin().command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

let transactionsSupported;

// Runs fn inside a transaction on replica sets (Atlas). Standalone dev servers do not
// support transactions, so fn runs without a session there.
export async function withTransaction(fn) {
  if (transactionsSupported === undefined) {
    try {
      const hello = await mongoose.connection.db.admin().command({ hello: 1 });
      transactionsSupported = Boolean(hello.setName || hello.msg === 'isdbgrid');
    } catch {
      transactionsSupported = false;
    }
  }
  if (!transactionsSupported) return fn(undefined);
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
