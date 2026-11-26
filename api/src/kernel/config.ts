import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Config {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  publicUrl: string;
  dataDir: string;
  /**
   * Directory of the built SPA to serve next to the API, or `null` for an
   * API-only process. The kernel serves `index.html` and the hashed assets from
   * here; everything else stays the client's business.
   */
  webDir: string | null;
  operator: { email: string; name: string };
  devMagicLink: boolean;
  /**
   * Test convenience, never on by default: the login page consumes the link it
   * was just shown instead of waiting for a click. Only effective together
   * with `devMagicLink`, so a secure origin can never auto-sign-in.
   */
  devAutoLogin: boolean;
  secureCookies: boolean;
  logLevel: string;
  trustProxy: boolean;
  bodyLimit: number;
  sessionTtlSeconds: number;
  magicLinkTtlSeconds: number;
  rateLimit: { enabled: boolean; magicLink: number };
}

function str(value: string | undefined, fallback: string): string {
  return value === undefined || value === '' ? fallback : value;
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

/**
 * Runtime configuration. Every value comes from a `SF_*` environment variable
 * with a development-friendly default; nothing secret is baked in.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv =
    env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development';
  const publicUrl = str(env.SF_PUBLIC_URL, 'http://127.0.0.1:5273');
  const dataDir = resolve(env.SF_DATA_DIR ?? './data');
  const webDirValue = env.SF_WEB_DIR;
  const webDir = webDirValue === undefined || webDirValue === '' ? null : resolve(webDirValue);
  const host = str(env.SF_HOST, '127.0.0.1');
  const loopbackHost =
    host === '127.0.0.1' || host === '::1' || host === 'localhost' || host.startsWith('127.');
  const secureCookies = bool(
    env.SF_SECURE_COOKIES,
    nodeEnv === 'production' || publicUrl.startsWith('https://'),
  );

  // Production must never run on an insecure origin or with an insecure session
  // cookie. Fail at startup instead of degrading silently: without this, a
  // deployment that forgets SF_PUBLIC_URL keeps running over http and hands the
  // session cookie to anyone on the wire.
  if (nodeEnv === 'production') {
    if (!publicUrl.startsWith('https://')) {
      throw new Error(
        `SF_PUBLIC_URL must start with https:// when NODE_ENV=production (got "${publicUrl}").`,
      );
    }
    if (!secureCookies) {
      throw new Error('SF_SECURE_COOKIES=0 is not allowed when NODE_ENV=production.');
    }
  }

  // Returning the sign-in link in the response is a development affordance. It
  // is off in production regardless of the variable, and additionally limited
  // to a loopback binding over plain http: on a public interface the link would
  // otherwise be the only credential needed to take over the operator account.
  const devMagicLink =
    nodeEnv !== 'production' &&
    bool(env.SF_DEV_MAGIC_LINK, true) &&
    loopbackHost &&
    !publicUrl.startsWith('https://');

  return {
    env: nodeEnv,
    host,
    port: int(env.SF_PORT, 8790),
    publicUrl,
    dataDir,
    webDir,
    operator: {
      email: str(env.SF_OPERATOR_EMAIL, 'operator@example.com').trim().toLowerCase(),
      name: str(env.SF_OPERATOR_NAME, 'Operator'),
    },
    devMagicLink,
    devAutoLogin: devMagicLink && bool(env.SF_DEV_AUTO_LOGIN, false),
    // The guard above rejects an insecure value in production, so this is the
    // single place that decides it: behind a TLS-terminating proxy
    // `SF_PUBLIC_URL` may still be http, and a session cookie without `Secure`
    // then travels in clear text on the last hop.
    secureCookies,
    logLevel: str(env.SF_LOG_LEVEL, nodeEnv === 'test' ? 'silent' : 'info'),
    trustProxy: bool(env.SF_TRUST_PROXY, false),
    bodyLimit: int(env.SF_BODY_LIMIT, 1_048_576),
    sessionTtlSeconds: 7 * 24 * 60 * 60,
    magicLinkTtlSeconds: 15 * 60,
    rateLimit: {
      enabled: bool(env.SF_RATE_LIMIT_ENABLED, true),
      magicLink: int(env.SF_RATE_LIMIT_MAGIC_LINK, 10),
    },
  };
}

/**
 * The data directory is created on first start (mode 0700). Databases and the
 * secret key live below it; nothing else writes there.
 */
export function ensureDataDir(config: Config): void {
  if (existsSync(config.dataDir)) return;
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
}
