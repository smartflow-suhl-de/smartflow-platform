import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/kernel/app.ts';
import { loadConfig, type Config } from '../../src/kernel/config.ts';

/**
 * Every test gets its own data directory under the OS temp dir: own databases,
 * own secret key, no port. Nothing ever touches `data/`.
 */
export interface TestApp {
  app: FastifyInstance;
  config: Config;
  dataDir: string;
  db: import('../../src/kernel/db.ts').Db;
  /** Verified tenant database, with the same boundary the plugins get. */
  tenantDb(tenantId: string): import('../../src/kernel/db.ts').Db;
  /** The kernel's in-process caller token, for route tests. */
  internalToken: string;
  /** Signs the operator in and returns the cookie header value. */
  signIn(email?: string): Promise<string>;
  close(): Promise<void>;
}

export async function createTestApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const dataDir = mkdtempSync(join(tmpdir(), 'sf-test-'));
  mkdirSync(dataDir, { recursive: true });

  const config = loadConfig({
    NODE_ENV: 'test',
    SF_DATA_DIR: dataDir,
    SF_PUBLIC_URL: 'http://127.0.0.1:5273',
    SF_DEV_MAGIC_LINK: '1',
    SF_RATE_LIMIT_ENABLED: '0',
    SF_LOG_LEVEL: 'silent',
    SF_OPERATOR_EMAIL: 'operator@example.com',
    ...overrides,
  });

  const { app, db, tenantDb, internalToken } = await buildApp({ config, logger: false });

  return {
    app,
    config,
    dataDir,
    db,
    tenantDb,
    internalToken,
    async signIn(email = config.operator.email) {
      const link = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/magic-link',
        payload: { email },
      });
      const body = link.json() as { link?: string };
      if (link.statusCode !== 202 || !body.link) {
        throw new Error(`magic link failed: ${link.statusCode} ${link.payload}`);
      }
      const token = new URL(body.link).searchParams.get('token');
      const confirm = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/confirm',
        payload: { token },
      });
      if (confirm.statusCode !== 200) {
        throw new Error(`confirm failed: ${confirm.statusCode} ${confirm.payload}`);
      }
      const raw = confirm.headers['set-cookie'];
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
