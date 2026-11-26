import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Config {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  publicUrl: string;
  dataDir: string;
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
  // A magic link may only be returned when the connection is not secure, and
  // auto-login is a second, explicit opt-in on top of that.
  const devMagicLink =
    bool(env.SF_DEV_MAGIC_LINK, nodeEnv !== 'production') && !publicUrl.startsWith('https://');

  return {
    env: nodeEnv,
    host: str(env.SF_HOST, '127.0.0.1'),
    port: int(env.SF_PORT, 8790),
    publicUrl,
    dataDir,
    operator: {
      email: str(env.SF_OPERATOR_EMAIL, 'operator@example.com').trim().toLowerCase(),
      name: str(env.SF_OPERATOR_NAME, 'Operator'),
    },
    devMagicLink,
    devAutoLogin: devMagicLink && bool(env.SF_DEV_AUTO_LOGIN, false),
    secureCookies: bool(env.SF_SECURE_COOKIES, publicUrl.startsWith('https://')),
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
