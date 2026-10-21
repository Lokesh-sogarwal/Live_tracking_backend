import { MongoMemoryReplSet } from 'mongodb-memory-server';

// One single-node replica set for the whole run (transactions need a replica set).
// Uses MONGOMS_SYSTEM_BINARY when set (e.g. /opt/homebrew/bin/mongod) to avoid a download.
let replSet;

export async function setup({ provide }) {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  provide('mongoUri', replSet.getUri());
}

export async function teardown() {
  await replSet?.stop();
}
