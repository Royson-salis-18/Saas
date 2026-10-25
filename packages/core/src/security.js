import { createHash, randomBytes, timingSafeEqual, scrypt, createHmac } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const hmacHex = (secret, data) => createHmac('sha256', secret).update(data).digest('hex');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// Verified against when the email is unknown so response time doesn't reveal accounts.
export const DUMMY_HASH = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$AAAAAAAAAAAAAAAAAAAAAA==$${Buffer.alloc(64).toString('base64')}`;

/** Fixed-window in-memory rate limiter. */
export function createRateLimiter() {
  const buckets = new Map();
  return {
    hit(key, max, windowMs, now = Date.now()) {
      if (buckets.size > 20000) {
        for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
      }
      let b = buckets.get(key);
      if (!b || b.resetAt <= now) {
        b = { count: 0, resetAt: now + windowMs };
        buckets.set(key, b);
      }
      b.count++;
      return { ok: b.count <= max, remaining: Math.max(0, max - b.count), retryAfter: Math.ceil((b.resetAt - now) / 1000) };
    },
    reset(key) {
      buckets.delete(key);
    },
  };
}

export const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
export const isEmail = (s) => typeof s === 'string' && s.length <= 254 && EMAIL_RE.test(s);
export const normEmail = (s) => String(s ?? '').trim().toLowerCase();

/** Trim + length-cap user text. */
export const clean = (s, max = 200) => String(s ?? '').trim().slice(0, max);

/** Only allow same-site relative redirects. */
export function safeNext(next, fallback = '/') {
  const s = String(next ?? '');
  return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') ? s : fallback;
}
