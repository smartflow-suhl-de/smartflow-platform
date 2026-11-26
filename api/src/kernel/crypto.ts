import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Tokens never reach storage in plaintext: the database keeps a SHA-256 hash,
 * the plaintext only exists in the link that was sent out.
 */
export function hashToken(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
