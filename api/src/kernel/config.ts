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
  secureCookies: boolean;
  logLevel: string;
  /**
   * How many reverse proxies sit in front of the process, as `0` (none) or a
   * hop count. Fastify's `true` trusts every hop and takes the leftmost
   * `X-Forwarded-For` entry, which any client can spoof; a hop count makes it
   * take the address the nearest trusted proxy appended.
   */
  trustProxy: number;
  bodyLimit: number;
  sessionTtlSeconds: number;
  /** Sign-in attempts per sender per minute, and three times as many per address per 15 minutes. */
  rateLimit: { enabled: boolean; login: number };
}

function str(value: string | undefined, fallback: string): string {
  return value === undefined || value === '' ? fallback : value;
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Converts `SF_TRUST_PROXY` into a hop count. `1` means "one proxy in front",
 * which is the only safe reading of the old boolean: trusting every hop lets a
 * client choose its own `request.ip` and slip past the rate limit.
 */
function trustProxyHops(value: string | undefined): number {
  if (value === undefined || value === '' || value === '0' || value.toLowerCase() === 'false') {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  // `true` means one hop; anything else (`no`, `off`, `-1`, typos) fails closed:
  // trusting no proxy is safe, guessing one is not.
  return value.toLowerCase() === 'true' ? 1 : 0;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

/**
 * Rejects a public origin that is not a bare `https://host` origin.
 *
 * `compose.yaml` assembles the value from two variables (`SF_TS_NODE_NAME` and
 * `SF_TAILNET_DOMAIN`), so a wrong half still produces a string that starts
 * with `https://`: `https://a.https://b`, `https://a..ts.net` or
 * `https://a/path` all pass a prefix check while pointing at an address no
 * client can reach. The session cookie is host-only, the OpenAPI entry and
 * every absolute link use this value, so the failure would surface as
 * "login does not stick" instead of a startup error.
 */
function assertPublicOrigin(value: string): void {
  let url: URL | null = null;
  try {
    url = new URL(value);
  } catch {
    url = null;
  }
  if (url === null || url.protocol !== 'https:') {
    throw new Error(
      `SF_PUBLIC_URL must start with https:// when NODE_ENV=production (got "${value}").`,
    );
  }
  // `origin` compares against the bare form: a path, a query, a trailing slash
  // or a second scheme glued into the host all diverge from it.
  if (url.origin !== value) {
    throw new Error(
      `SF_PUBLIC_URL must be a bare origin without path, query or trailing slash (got "${value}").`,
    );
  }
  // An empty label cannot be resolved and comes from an empty or malformed half
  // of the composed value (for example a leading dot in SF_TAILNET_DOMAIN).
  if (url.hostname.split('.').some((label) => label === '')) {
    throw new Error(
      `SF_PUBLIC_URL has an empty domain label (got "${value}"); check SF_TS_NODE_NAME and SF_TAILNET_DOMAIN.`,
    );
  }
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
  const secureCookies = bool(
    env.SF_SECURE_COOKIES,
    nodeEnv === 'production' || publicUrl.startsWith('https://'),
  );

  // Production must never run on an insecure origin or with an insecure session
  // cookie. Fail at startup instead of degrading silently: without this, a
  // deployment that forgets SF_PUBLIC_URL keeps running over http and hands the
  // session cookie to anyone on the wire.
  if (nodeEnv === 'production') {
    assertPublicOrigin(publicUrl);
    if (!secureCookies) {
      throw new Error('SF_SECURE_COOKIES=0 is not allowed when NODE_ENV=production.');
    }
  }

  return {
    env: nodeEnv,
    host,
    port: int(env.SF_PORT, 8790),
    publicUrl,
    dataDir,
    webDir,
    // The guard above rejects an insecure value in production, so this is the
    // single place that decides it: behind a TLS-terminating proxy
    // `SF_PUBLIC_URL` may still be http, and a session cookie without `Secure`
    // then travels in clear text on the last hop.
    secureCookies,
    logLevel: str(env.SF_LOG_LEVEL, nodeEnv === 'test' ? 'silent' : 'info'),
    trustProxy: trustProxyHops(env.SF_TRUST_PROXY),
    bodyLimit: int(env.SF_BODY_LIMIT, 1_048_576),
    sessionTtlSeconds: 7 * 24 * 60 * 60,
    rateLimit: {
      enabled: bool(env.SF_RATE_LIMIT_ENABLED, true),
      login: int(env.SF_RATE_LIMIT_LOGIN, 10),
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
