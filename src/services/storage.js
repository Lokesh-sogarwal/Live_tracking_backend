import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Object storage for driver documents. Keys are server-generated
// ("driver-docs/<userUuid>/<uuid>.<ext>"), never derived from user input.

function localStorage(baseDir) {
  const root = path.resolve(baseDir);
  const resolve = (key) => {
    const full = path.resolve(root, key);
    if (!full.startsWith(root + path.sep)) throw new Error('Invalid storage key');
    return full;
  };
  return {
    driver: 'local',
    async put(key, buffer) {
      const full = resolve(key);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, buffer, { flag: 'wx' });
    },
    async get(key) {
      const full = resolve(key);
      const info = await stat(full).catch(() => null);
      if (!info?.isFile()) return null;
      return { stream: createReadStream(full), size: info.size };
    },
    async exists(key) {
      return Boolean(await stat(resolve(key)).catch(() => null));
    },
    async remove(key) {
      await rm(resolve(key), { force: true });
    },
  };
}

async function s3Storage(config) {
  const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } = await import(
    '@aws-sdk/client-s3'
  );
  // Credentials come from the standard AWS provider chain (AWS_ACCESS_KEY_ID /
  // AWS_SECRET_ACCESS_KEY env vars or an attached role), never from source.
  const client = new S3Client({
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT || undefined,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
  });
  const Bucket = config.UPLOAD_BUCKET;
  return {
    driver: 's3',
    async put(key, buffer, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket, Key: key, Body: buffer, ContentType: contentType, ServerSideEncryption: 'AES256' }),
      );
    },
    async get(key) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        return { stream: out.Body, size: out.ContentLength };
      } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },
    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return true;
      } catch {
        return false;
      }
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
}

export async function createStorage(config) {
  return config.STORAGE_DRIVER === 's3' ? s3Storage(config) : localStorage(config.LOCAL_UPLOAD_DIR);
}
