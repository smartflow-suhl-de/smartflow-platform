import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/kernel/app.ts';
import type { AuthService } from '../../src/kernel/auth.ts';
import { loadConfig, type Config } from '../../src/kernel/config.ts';
import type { Db } from '../../src/kernel/db.ts';
import { newId } from '../../src/kernel/ids.ts';
import { hashPassword } from '../../src/kernel/password.ts';
import type { Role } from '../../src/shared/contract.ts';

/** The account most tests act as; setup is exercised separately in auth.test.ts. */
export const TEST_EMAIL = 'operator@example.com';
export const TEST_NAME = 'Operator';
/** Long enough for the setup rule, and not a secret anywhere. */
export const TEST_PASSWORD = 'correct horse battery staple';

/**
 * Every test gets its own data directory under the OS temp dir: own databases,
 * own secret key, no port. Nothing ever touches `data/`.
 */
export interface TestApp {
  app: FastifyInstance;
  config: Config;
  dataDir: string;
  db: Db;
  /** Verified tenant database, with the same boundary the plugins get. */
  tenantDb(tenantId: string): Db;
  /** The kernel's auth service, for tests that look at session state. */
  auth: AuthService;
  /** The kernel's in-process caller token, for route tests. */
  internalToken: string;
  /** Signs an account in with the test password and returns the cookie header value. */
  signIn(email?: string, role?: Role): Promise<string>;
  close(): Promise<void>;
}

export interface TestAppOptions {
  /** Capture the request log instead of discarding it. */
  logStream?: { write(line: string): void };
}

/**
 * One scrypt hash per test file. The parameters are deliberately expensive, so
 * hashing per test would dominate the suite; the salt is shared here only
 * because the value never leaves the test database.
 */
const sharedPasswordHash = hashPassword(TEST_PASSWORD);

/**
 * Gives an account a usable password without going through setup: `signIn` is
 * about the session, and the setup route has its own tests.
 */
async function ensurePassword(db: Db, email: string, role: Role): Promise<void> {
  const hash = await sharedPasswordHash;
  const existing = db.prepare('select id from users where email = ?').get(email) as
    { id: string } | undefined;
  if (existing) {
    db.prepare('update users set password_hash = ? where id = ?').run(hash, existing.id);
    return;
  }
  db.prepare(
    'insert into users (id, email, name, role, tenant_id, password_hash, created_at) values (?, ?, ?, ?, ?, ?, ?)',
  ).run(newId('usr'), email, TEST_NAME, role, null, hash, new Date().toISOString());
}

export async function createTestApp(
  overrides: Record<string, string> = {},
  options: TestAppOptions = {},
): Promise<TestApp> {
  const dataDir = mkdtempSync(join(tmpdir(), 'sf-test-'));
  mkdirSync(dataDir, { recursive: true });

  const config = loadConfig({
    NODE_ENV: 'test',
    SF_DATA_DIR: dataDir,
    SF_PUBLIC_URL: 'http://127.0.0.1:5273',
    SF_RATE_LIMIT_ENABLED: '0',
    SF_LOG_LEVEL: 'silent',
    ...overrides,
  });

  const { app, db, tenantDb, internalToken, auth } = await buildApp({
    config,
    logger: options.logStream !== undefined,
    ...(options.logStream ? { logStream: options.logStream } : {}),
  });

  return {
    app,
    config,
    dataDir,
    db,
    tenantDb,
    auth,
    internalToken,
    async signIn(email = TEST_EMAIL, role: Role = 'operator') {
      await ensurePassword(db, email, role);
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: TEST_PASSWORD },
      });
      if (login.statusCode !== 200) {
        throw new Error(`login failed: ${login.statusCode} ${login.payload}`);
      }
      const raw = login.headers['set-cookie'];
      const cookie = Array.isArray(raw) ? raw[0] : raw;
      if (!cookie) throw new Error('no session cookie');
      return cookie.split(';')[0] as string;
    },
    async close() {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
