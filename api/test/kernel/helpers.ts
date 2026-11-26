import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/kernel/app.ts';
import { loadConfig, type Config } from '../../src/kernel/config.ts';
import type { MagicLinkMail, Mailer } from '../../src/kernel/mailer.ts';

/**
 * In-memory transport for every test. Nothing in `npm test` may open a socket,
 * so the harness always injects this one instead of letting the app build a
 * real SMTP transport from the environment.
 */
export class RecordingMailer implements Mailer {
  readonly isConfigured: boolean;
  readonly sent: MagicLinkMail[] = [];
  #failure: Error | null = null;

  constructor(options: { configured?: boolean } = {}) {
    this.isConfigured = options.configured ?? true;
  }

  /** Makes the next send reject, like a relay that refuses the message. */
  failWith(error: Error): void {
    this.#failure = error;
  }

  async sendMagicLink(mail: MagicLinkMail): Promise<void> {
    if (this.#failure !== null) throw this.#failure;
    this.sent.push(mail);
  }
}

/** Lets the fire-and-forget delivery run and its error handler write. */
export async function settleDelivery(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Every test gets its own data directory under the OS temp dir: own databases,
 * own secret key, no port. Nothing ever touches `data/`.
 */
export interface TestApp {
  app: FastifyInstance;
  config: Config;
  dataDir: string;
  db: import('../../src/kernel/db.ts').Db;
  /** The transport the app was built with. */
  mailer: Mailer;
  /** Verified tenant database, with the same boundary the plugins get. */
  tenantDb(tenantId: string): import('../../src/kernel/db.ts').Db;
  /** The kernel's in-process caller token, for route tests. */
  internalToken: string;
  /** Signs the operator in and returns the cookie header value. */
  signIn(email?: string): Promise<string>;
  close(): Promise<void>;
}

export interface TestAppOptions {
  /** Capture the request log instead of discarding it. */
  logStream?: { write(line: string): void };
  /** Override the transport; defaults to a recording stub that never connects. */
  mailer?: Mailer;
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
    SF_DEV_MAGIC_LINK: '1',
    SF_RATE_LIMIT_ENABLED: '0',
    SF_LOG_LEVEL: 'silent',
    SF_OPERATOR_EMAIL: 'operator@example.com',
    ...overrides,
  });

  const { app, db, tenantDb, internalToken, mailer } = await buildApp({
    config,
    logger: options.logStream !== undefined,
    // A configured stub by default: the baseline tests expect the API to report
    // a delivery, and a stub keeps that promise without a socket. Tests that
    // exercise the no-transport path pass their own `RecordingMailer`.
    mailer: options.mailer ?? new RecordingMailer(),
    ...(options.logStream ? { logStream: options.logStream } : {}),
  });

  return {
    app,
    config,
    dataDir,
    db,
    mailer,
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
