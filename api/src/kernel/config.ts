import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The shape the signup form and the SMTP sender both accept. */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** STARTTLS submission is the port every relay offers; 25 is blocked often. */
const DEFAULT_SMTP_PORT = 587;
/** Implicit TLS. A port of 465 implies `secure` unless it is set explicitly. */
const IMPLICIT_TLS_PORT = 465;

/**
 * Mail transport settings. `host === null` means "no transport configured":
 * the process sends nothing and the API says so instead of claiming a mailbox
 * to check. Production refuses to start in that state.
 */
export interface SmtpConfig {
  host: string | null;
  port: number;
  secure: boolean;
  user: string | null;
  pass: string | null;
  from: string;
  replyTo: string | null;
}

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
  smtp: SmtpConfig;
  devMagicLink: boolean;
  /**
   * Test convenience, never on by default: the login page consumes the link it
   * was just shown instead of waiting for a click. Only effective together
   * with `devMagicLink`, so a secure origin can never auto-sign-in.
   */
  devAutoLogin: boolean;
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
  // `true` and unknown values keep the conservative single-hop assumption
  // instead of silently trusting the whole chain.
  return value.toLowerCase() === 'true' ? 1 : 1;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

function optional(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function smtpPort(value: string | undefined): number {
  const raw = (value ?? '').trim();
  if (raw === '') return DEFAULT_SMTP_PORT;
  const port = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  // No silent fallback here: a typo in the port is otherwise indistinguishable
  // from "not set" and would quietly switch the relay address.
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`SF_SMTP_PORT must be a TCP port between 1 and 65535 (got "${value}").`);
  }
  return port;
}

/**
 * Reads the SMTP password. A file wins over the variable because a Docker
 * secret or a mounted file is the only way to keep the value out of `docker
 * inspect` and the process environment. A missing file is a startup error: a
 * transport that cannot authenticate would otherwise fail only on the first
 * sign-in attempt, when nobody is looking at the logs.
 */
function smtpPassword(env: NodeJS.ProcessEnv): string | null {
  const path = optional(env.SF_SMTP_PASS_FILE);
  if (path !== null) {
    let contents: string;
    try {
      contents = readFileSync(path, 'utf8').trim();
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'unknown error';
      throw new Error(`SF_SMTP_PASS_FILE could not be read (${path}): ${code}.`);
    }
    // An empty file must not pass as "a password is set": the process would
    // start, authenticate with an empty string and fail only on the first
    // sign-in — the same silent failure the missing-file guard prevents. The
    // contents stay out of the message.
    if (contents === '') {
      throw new Error(`SF_SMTP_PASS_FILE is empty (${path}).`);
    }
    return contents;
  }
  return optional(env.SF_SMTP_PASS);
}

/**
 * SMTP settings from `SF_SMTP_*`. Every partially set combination throws: a
 * transport that is "mostly" configured loses mail silently, and a magic link
 * that never arrives looks exactly like a wrong address to the person waiting
 * for it.
 */
function loadSmtp(env: NodeJS.ProcessEnv, operatorEmail: string): SmtpConfig {
  const host = optional(env.SF_SMTP_HOST);
  const from = optional(env.SF_SMTP_FROM) ?? operatorEmail;
  const replyTo = optional(env.SF_SMTP_REPLY_TO);

  // A display name is allowed ("SmartFlow <no-reply@example.test>"), but the
  // bare form must be a plain address: a typo here is a mail that silently
  // leaves from the wrong sender.
  const guardAddress = (name: string, value: string): string => {
    const address = /<([^>]*)>/.exec(value)?.[1]?.trim() ?? value;
    if (!EMAIL_PATTERN.test(address)) {
      throw new Error(`${name} must be a plain email address (got "${value}").`);
    }
    return value;
  };

  guardAddress('SF_SMTP_FROM', from);
  if (replyTo !== null) guardAddress('SF_SMTP_REPLY_TO', replyTo);

  if (host === null) {
    // Any transport-specific variable without a host means an incomplete
    // configuration. Checking only user/pass would let a forgotten host look
    // like a working setup that sends nowhere.
    const stray = (
      [
        'SF_SMTP_PORT',
        'SF_SMTP_SECURE',
        'SF_SMTP_USER',
        'SF_SMTP_PASS',
        'SF_SMTP_PASS_FILE',
      ] as const
    ).find((name) => optional(env[name]) !== null);
    if (stray !== undefined) {
      throw new Error(`${stray} is set but SF_SMTP_HOST is not; the mail transport is incomplete.`);
    }
    return {
      host: null,
      port: DEFAULT_SMTP_PORT,
      secure: false,
      user: null,
      pass: null,
      from,
      replyTo,
    };
  }

  const port = smtpPort(env.SF_SMTP_PORT);
  const user = optional(env.SF_SMTP_USER);
  const pass = smtpPassword(env);
  if (user !== null && pass === null) {
    throw new Error(
      `SF_SMTP_USER is set but no password is available; set SF_SMTP_PASS or SF_SMTP_PASS_FILE.`,
    );
  }
  if (user === null && pass !== null) {
    throw new Error(
      'An SMTP password is set but SF_SMTP_USER is not; the transport is incomplete.',
    );
  }

  return {
    host,
    port,
    // Explicit setting wins; 465 is implicit TLS by convention and sending
    // STARTTLS there would hand the credentials to a plaintext port.
    secure: bool(env.SF_SMTP_SECURE, port === IMPLICIT_TLS_PORT),
    user,
    pass,
    from,
    replyTo,
  };
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
  const operatorEmail = str(env.SF_OPERATOR_EMAIL, 'operator@example.com').trim().toLowerCase();
  const smtp = loadSmtp(env, operatorEmail);
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
    // A production process without a transport cannot deliver the only
    // credential it accepts. It used to start and tell people to check an inbox
    // that would never receive anything; refusing to boot is the honest answer.
    if (smtp.host === null) {
      throw new Error(
        'SF_SMTP_HOST is required when NODE_ENV=production: without a mail transport nobody can sign in.',
      );
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
      email: operatorEmail,
      name: str(env.SF_OPERATOR_NAME, 'Operator'),
    },
    smtp,
    devMagicLink,
    devAutoLogin: devMagicLink && bool(env.SF_DEV_AUTO_LOGIN, false),
    // The guard above rejects an insecure value in production, so this is the
    // single place that decides it: behind a TLS-terminating proxy
    // `SF_PUBLIC_URL` may still be http, and a session cookie without `Secure`
    // then travels in clear text on the last hop.
    secureCookies,
    logLevel: str(env.SF_LOG_LEVEL, nodeEnv === 'test' ? 'silent' : 'info'),
    trustProxy: trustProxyHops(env.SF_TRUST_PROXY),
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
