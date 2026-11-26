import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing with scrypt from Node's own crypto module: no hashing
 * dependency, no native build step in the image.
 *
 * A stored value carries its own parameters (`scrypt$N$r$p$salt$hash`), so the
 * work factor can be raised later without invalidating existing passwords.
 *
 * The cost is memory: N=2^16, r=8 needs 64 MiB per derivation. That is the
 * reason for the concurrency cap below — a burst of sign-ins must not reserve
 * hundreds of megabytes, which on a small host is a denial of service by
 * design. Two parallel derivations bound it at ~128 MiB.
 */
const N = 65_536;
const R = 8;
const P = 1;
const KEY_BYTES = 64;
const SALT_BYTES = 16;

/** Bounds for values read back from the database; a tampered row must not ask for 4 GiB. */
const MIN_N = 2 ** 14;
const MAX_N = 2 ** 17;
const MAX_R = 32;
const MAX_P = 8;
const MIN_KEY_BYTES = 32;
const MAX_KEY_BYTES = 128;
const MAX_SALT_BYTES = 64;

const MAX_PARALLEL = 2;
const MAX_QUEUE = 64;

/**
 * A steady, obviously wrong value used when the address is unknown. Hashing
 * against it costs the same as a real check, so the response time does not
 * reveal whether an account exists.
 */
const DUMMY_HASH =
  'scrypt$65536$8$1$KjtMXW5_gJGis8TV5vcIGQ$B5x3IfVkZ1bh2PxWiIjuiacO54-8V-0mNkLcwHKeTKEgUOI1Q6OrzS16kJ1Y_ghqyAIkF3rTujTTHRGYMgYklg';

/** The server is saturated with password work; the caller should retry shortly. */
export class PasswordBusyError extends Error {
  constructor() {
    super('password_busy');
    this.name = 'PasswordBusyError';
  }
}

let active = 0;
const waiting: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < MAX_PARALLEL) {
    active += 1;
    return Promise.resolve();
  }
  if (waiting.length >= MAX_QUEUE) return Promise.reject(new PasswordBusyError());
  return new Promise((resolve) => {
    waiting.push(() => {
      active += 1;
      resolve();
    });
  });
}

function release(): void {
  active -= 1;
  const next = waiting.shift();
  if (next) next();
}

function derive(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
  keyBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      keyBytes,
      // Node refuses a derivation whose memory need exceeds `maxmem`; give it
      // exactly what the validated parameters need plus headroom.
      { N: n, r, p, maxmem: 128 * n * r + 8 * 1024 * 1024 },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

/** Hashes a password the caller has already validated. Never stores the plaintext. */
export async function hashPassword(plain: string): Promise<string> {
  if (plain.length === 0 || plain.length > 512) {
    throw new Error('password_invalid');
  }
  const salt = randomBytes(SALT_BYTES);
  await acquire();
  try {
    const key = await derive(plain, salt, N, R, P, KEY_BYTES);
    return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
  } finally {
    release();
  }
}

/** Constant-time check against a stored value. Malformed values simply do not match. */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  if (
    nRaw === undefined ||
    rRaw === undefined ||
    pRaw === undefined ||
    saltRaw === undefined ||
    hashRaw === undefined
  ) {
    return false;
  }
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  const salt = Buffer.from(saltRaw, 'base64url');
  const expected = Buffer.from(hashRaw, 'base64url');
  if (
    !Number.isInteger(n) ||
    n < MIN_N ||
    n > MAX_N ||
    (n & (n - 1)) !== 0 ||
    !Number.isInteger(r) ||
    r < 1 ||
    r > MAX_R ||
    !Number.isInteger(p) ||
    p < 1 ||
    p > MAX_P ||
    salt.length < 8 ||
    salt.length > MAX_SALT_BYTES ||
    expected.length < MIN_KEY_BYTES ||
    expected.length > MAX_KEY_BYTES
  ) {
    return false;
  }

  await acquire();
  try {
    const actual = await derive(plain, salt, n, r, p, expected.length);
    return timingSafeEqual(actual, expected);
  } finally {
    release();
  }
}

/**
 * Burns the same work as a real verification for an address that does not
 * exist, so a timing difference does not become an account oracle.
 */
export async function verifyAgainstDummy(plain: string): Promise<void> {
  try {
    await verifyPassword(plain, DUMMY_HASH);
  } catch (error) {
    if (error instanceof PasswordBusyError) throw error;
    // A broken hash must not change the answer: the login still fails.
  }
}
