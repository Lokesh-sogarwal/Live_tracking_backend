import bcrypt from 'bcryptjs';
import { createHash, pbkdf2, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const pbkdf2Async = promisify(pbkdf2);

const BCRYPT_COST = process.env.NODE_ENV === 'test' ? 4 : 12;

export const hashPassword = (plain) => bcrypt.hash(plain, BCRYPT_COST);

const safeEqualHex = (a, bHex) => {
  const b = Buffer.from(bHex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};

// Werkzeug format: "<method>$<salt>$<hex digest>", e.g.
//   scrypt:32768:8:1$<salt>$<hex>   (Werkzeug >= 3.0 default)
//   pbkdf2:sha256:600000$<salt>$<hex>
async function verifyWerkzeug(plain, stored) {
  const [method, salt, digest] = stored.split('$');
  if (!method || !salt || !digest) return false;

  if (method.startsWith('scrypt:')) {
    const [, n, r, p] = method.split(':').map(Number);
    if (!n || !r || !p) return false;
    const key = await scryptAsync(plain, salt, 64, { N: n, r, p, maxmem: 132 * n * r * p });
    return safeEqualHex(key, digest);
  }

  if (method.startsWith('pbkdf2:')) {
    const [, alg, iterStr] = method.split(':');
    const iterations = Number(iterStr);
    if (!alg || !iterations) return false;
    const keyLen = createHash(alg).digest().length;
    const key = await pbkdf2Async(plain, salt, iterations, keyLen, alg);
    return safeEqualHex(key, digest);
  }

  return false;
}

// Returns { ok, needsRehash }. Legacy Werkzeug hashes verify but are flagged for upgrade.
export async function verifyPassword(plain, stored) {
  if (typeof plain !== 'string' || typeof stored !== 'string' || !stored) return { ok: false, needsRehash: false };
  if (/^\$2[aby]\$/.test(stored)) {
    return { ok: await bcrypt.compare(plain, stored), needsRehash: false };
  }
  try {
    const ok = await verifyWerkzeug(plain, stored);
    return { ok, needsRehash: ok };
  } catch {
    return { ok: false, needsRehash: false };
  }
}
