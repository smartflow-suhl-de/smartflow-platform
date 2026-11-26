import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Secrets that have to be read back later are sealed at rest, not hashed: a
 * one-time claim waits server-side until the customer's server picks it
 * up. Hashing would make that impossible; plaintext would put a credential in a
 * backup.
 *
 * AES-256-GCM with a random 96-bit IV per value and the IV and tag stored next
 * to the ciphertext. The key lives in `secrets.key` below the data directory,
 * mode 0600, created once. A changed key makes every sealed value unreadable —
 * which is the point of a key, not a bug to paper over.
 */
const KEY_FILE = 'secrets.key';
const PREFIX = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

const keyCache = new Map<string, Buffer>();

function keyFile(dataDir: string): string {
  return join(dataDir, KEY_FILE);
}

/**
 * Reads the key or creates it. Written with `wx` so two processes starting at
 * the same time cannot each install their own key: the loser reads the winner's
 * file instead of overwriting it.
 */
export function loadOrCreateKey(dataDir: string): Buffer {
  const cached = keyCache.get(dataDir);
  if (cached) return cached;

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = keyFile(dataDir);
  if (!existsSync(file)) {
    try {
      writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      // A concurrent start created it first; reading is the correct answer.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  chmodSync(file, 0o600);

  const key = readFileSync(file);
  if (key.length !== 32) {
    throw new Error(`${file} must hold exactly 32 bytes for AES-256`);
  }
  keyCache.set(dataDir, key);
  return key;
}

/** Seals and opens strings with one key. Values are self-describing (`v1.…`). */
export class SecretBox {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('a secret box needs a 32-byte key');
    this.#key = key;
  }

  seal(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      PREFIX,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  /**
   * Throws on a wrong key and on a tampered value. Callers turn that into a
   * refusal with a reason; a sealed value that no longer opens is a fact about
   * the data directory, not something to guess around.
   */
  open(sealed: string): string {
    const parts = sealed.split('.');
    if (parts.length !== 4 || parts[0] !== PREFIX) {
      throw new Error('sealed value has an unknown format');
    }
    const iv = Buffer.from(parts[1] as string, 'base64url');
    const tag = Buffer.from(parts[2] as string, 'base64url');
    const ciphertext = Buffer.from(parts[3] as string, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new Error('sealed value is truncated');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.#key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}

/** The box for one data directory; the key is read once per process. */
export function openSecretBox(dataDir: string): SecretBox {
  return new SecretBox(loadOrCreateKey(dataDir));
}
