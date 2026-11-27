import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

/**
 * Tokens never reach storage in plaintext: the database keeps a SHA-256 hash,
 * the plaintext only exists in the link that was sent out.
 */
export function hashToken(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Pseudonymises a value for a log line with the instance key.
 *
 * A bare SHA-256 of an address is not an anonymisation: for a known company
 * domain a dictionary over the local part recovers it. The HMAC needs the key
 * from the data directory, so the same log line is useless to anyone who does
 * not hold it.
 */
export function pseudonymize(value: string, key: Buffer): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
