import type { FastifyInstance, FastifyReply } from 'fastify';
import { FieldError, type AuthMe } from '../../shared/contract.ts';
import { SESSION_COOKIE, authMeFor } from '../app.ts';
import { AuthError, type AuthService } from '../auth.ts';
import type { Config } from '../config.ts';
import { AppError } from '../errors.ts';
import { PasswordBusyError } from '../password.ts';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A new password must be long enough to matter; length is the only rule. */
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 256;

const errorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        fields: { type: 'object', additionalProperties: { type: 'string' } },
        reason: { type: 'string' },
      },
    },
  },
} as const;

const tenantRefSchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: ['id', 'name', 'slug'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    slug: { type: 'string' },
  },
} as const;

const authMeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['user', 'tenant', 'activeTenant'],
  properties: {
    user: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'email', 'name', 'role'],
      properties: {
        id: { type: 'string' },
        email: { type: 'string' },
        name: { type: 'string' },
        role: { type: 'string', enum: ['operator', 'tenant_admin', 'employee'] },
      },
    },
    tenant: tenantRefSchema,
    activeTenant: tenantRefSchema,
  },
} as const;

/** Upper bound on tracked keys per limiter; the oldest are evicted beyond it. */
const MAX_KEYS = 10_000;

/**
 * Collapses an address to the unit an attacker cannot cheaply multiply:
 * IPv4-mapped IPv6 becomes IPv4, other IPv6 is cut to its /64 prefix.
 */
export function normalizeIp(ip: string): string {
  const lower = ip.toLowerCase().split('%')[0] ?? '';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (mapped) return mapped[1] as string;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = Number.parseInt(hex[1] as string, 16);
    const lo = Number.parseInt(hex[2] as string, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  if (!lower.includes(':')) return lower;
  const [head = '', tail] = lower.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = Math.max(0, 8 - headGroups.length - tailGroups.length);
  const groups = [
    ...headGroups,
    ...(tail === undefined ? [] : Array<string>(missing).fill('0')),
    ...tailGroups,
  ];
  return `${groups
    .slice(0, 4)
    .map((g) => (g === '' ? '0' : g.replace(/^0+(?=.)/, '')))
    .join(':')}::/64`;
}

/** Sliding-window counter per key, held in memory and bounded. A restart clears it. */
function createLimiter(limit: number, windowMs: number) {
  // Map keeps insertion order: the first key is the oldest-inserted one.
  const hits = new Map<string, number[]>();
  let lastPrune = 0;

  const prune = (at: number): void => {
    const since = at - windowMs;
    for (const [key, times] of hits) {
      const fresh = times.filter((time) => time > since);
      if (fresh.length === 0) hits.delete(key);
      else hits.set(key, fresh);
    }
  };

  /** Returns 0 when the attempt is allowed, else the milliseconds until the window frees a slot. */
  return (key: string, at: number): number => {
    // Prune at most once per second, and only when the map is large.
    if (hits.size >= MAX_KEYS && at - lastPrune >= 1000) {
      lastPrune = at;
      prune(at);
    }
    // Still full: evict the oldest keys so memory and per-request work stay bounded.
    while (hits.size >= MAX_KEYS && !hits.has(key)) {
      const oldest = hits.keys().next().value;
      if (oldest === undefined) break;
      hits.delete(oldest);
    }
    const times = (hits.get(key) ?? []).filter((time) => time > at - windowMs);
    if (times.length >= limit) {
      hits.delete(key);
      hits.set(key, times);
      return Math.max(1, (times[0] as number) + windowMs - at);
    }
    times.push(at);
    hits.delete(key);
    hits.set(key, times);
    return 0;
  };
}

/** Whole seconds, rounded up, never below 1. */
function retryAfterSeconds(ms: number): string {
  return String(Math.max(1, Math.ceil(ms / 1000)));
}

export interface AuthRouteOptions {
  auth: AuthService;
  config: Config;
  now: () => Date;
  resolveTenant: (
    tenantId: string,
  ) => { id: string; name: string; slug: string; status?: 'active' | 'suspended' } | null;
}

function setSessionCookie(reply: FastifyReply, token: string, config: Config): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    maxAge: config.sessionTtlSeconds,
  });
}

/** Maps the auth service's typed failures to the shared error shape. */
function asHttpError(error: unknown): never {
  if (error instanceof AuthError) {
    if (error.code === 'setup_complete') {
      throw new AppError('setup_complete', 'Setup is already complete.', 409);
    }
    if (error.code === 'email_taken') {
      throw new FieldError({ email: 'This email address is already in use.' });
    }
    throw new AppError('invalid_credentials', 'Email or password is wrong.', 401);
  }
  if (error instanceof PasswordBusyError) {
    throw new AppError('busy', 'The server is busy signing in. Please try again in a moment.', 503);
  }
  throw error;
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  const { auth, config, now, resolveTenant } = options;
  const allowLogin = createLimiter(config.rateLimit.login, 60_000);
  // Setup has its own bucket: a first-run setup followed by a sign-in must not
  // spend the sign-in budget of the same address.
  const allowSetup = createLimiter(config.rateLimit.login, 60_000);
  // A second, independent bucket per address: the per-IP limit alone is either
  // spoofable behind a trusted proxy or a shared bucket for every client, and in
  // both cases one account could be flooded with guesses.
  const allowLoginForEmail = createLimiter(config.rateLimit.login * 3, 15 * 60_000);

  /**
   * Public on purpose: the login page asks this before it renders a form, and
   * the answer carries nothing but a boolean. It never names an account.
   */
  app.get(
    '/auth/setup',
    {
      schema: {
        summary: 'Whether first-run setup is still required',
        tags: ['auth'],
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['required'],
            properties: { required: { type: 'boolean' } },
          },
        },
      },
    },
    async () => ({ required: auth.setupRequired() }),
  );

  app.post<{ Body: { email?: string; name?: string; password?: string } }>(
    '/auth/setup',
    {
      schema: {
        summary: 'Create the first operator account and sign it in',
        tags: ['auth'],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email', 'name', 'password'],
          properties: {
            email: { type: 'string', minLength: 3, maxLength: 254 },
            name: { type: 'string', minLength: 1, maxLength: 80 },
            password: { type: 'string', minLength: 1, maxLength: PASSWORD_MAX },
          },
        },
        response: {
          201: authMeSchema,
          409: errorSchema,
          422: errorSchema,
          429: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const email = (request.body.email ?? '').trim().toLowerCase();
      const name = (request.body.name ?? '').trim();
      const password = request.body.password ?? '';

      const fields: Record<string, string> = {};
      if (!EMAIL_PATTERN.test(email)) {
        fields.email = 'Please enter a valid email address.';
      }
      if (name.length === 0) {
        fields.name = 'Please enter a name.';
      }
      if (password.length < PASSWORD_MIN || password.trim().length === 0) {
        fields.password = `Use at least ${PASSWORD_MIN} characters.`;
      }
      if (Object.keys(fields).length > 0) throw new FieldError(fields);

      const setupWaitMs = config.rateLimit.enabled
        ? allowSetup(normalizeIp(request.ip), now().getTime())
        : 0;
      if (setupWaitMs > 0) {
        reply.header('Retry-After', retryAfterSeconds(setupWaitMs));
        throw new AppError('rate_limited', 'Too many attempts. Please try again later.', 429);
      }

      // A race between two setups is a 409, not a second operator: the service
      // re-checks after the hash and throws the typed error.
      const result = await auth
        .setup({ email, name, password }, request.headers['user-agent'])
        .catch(asHttpError);

      setSessionCookie(reply, result.sessionToken, config);
      reply.code(201);
      return authMeFor(result.user, resolveTenant);
    },
  );

  app.post<{ Body: { email?: string; password?: string } }>(
    '/auth/login',
    {
      schema: {
        summary: 'Sign in with email and password',
        tags: ['auth'],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', minLength: 3, maxLength: 254 },
            password: { type: 'string', minLength: 1, maxLength: PASSWORD_MAX },
          },
        },
        response: {
          200: authMeSchema,
          401: errorSchema,
          422: errorSchema,
          429: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const email = (request.body.email ?? '').trim().toLowerCase();
      const password = request.body.password ?? '';

      const fields: Record<string, string> = {};
      if (!EMAIL_PATTERN.test(email)) {
        fields.email = 'Please enter a valid email address.';
      }
      if (password.length === 0) {
        fields.password = 'Please enter your password.';
      }
      if (Object.keys(fields).length > 0) throw new FieldError(fields);

      const nowMs = now().getTime();
      if (config.rateLimit.enabled) {
        // Same order and short circuit as before; only the bucket that tripped is
        // remembered, so Retry-After matches its window (60 s or 15 min).
        const waitMs =
          allowLogin(normalizeIp(request.ip), nowMs) || allowLoginForEmail(email, nowMs);
        if (waitMs > 0) {
          reply.header('Retry-After', retryAfterSeconds(waitMs));
          throw new AppError(
            'rate_limited',
            'Too many sign-in attempts. Please try again later.',
            429,
          );
        }
      }

      // Unknown address and wrong password are one answer, byte for byte.
      const result = await auth
        .login(email, password, request.headers['user-agent'])
        .catch(asHttpError);

      setSessionCookie(reply, result.sessionToken, config);
      return authMeFor(result.user, resolveTenant);
    },
  );

  app.get(
    '/auth/me',
    {
      preHandler: app.authenticate,
      schema: {
        summary: 'The signed-in user and their tenant',
        tags: ['auth'],
        response: { 200: authMeSchema, 401: errorSchema },
      },
    },
    async (request): Promise<AuthMe> => {
      if (!request.user) throw new AppError('unauthorized', 'Anmeldung erforderlich.', 401);
      return authMeFor(request.user, resolveTenant);
    },
  );

  /**
   * Operator only: choose the tenant this session works in, or `null` to leave
   * it. The choice lives in the server-side session, never in a client header.
   * Every failure answers before anything changes, so the session stays as it was.
   */
  app.post<{ Body: { tenantId?: string | null } }>(
    '/auth/tenant',
    {
      preHandler: app.requireRole('operator'),
      schema: {
        summary: 'Choose the tenant this operator session works in',
        tags: ['auth'],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId'],
          properties: { tenantId: { type: ['string', 'null'], minLength: 1, maxLength: 80 } },
        },
        response: {
          200: authMeSchema,
          401: errorSchema,
          403: errorSchema,
          404: errorSchema,
          422: errorSchema,
        },
      },
    },
    async (request) => {
      const user = request.user;
      if (!user) throw new AppError('unauthorized', 'Anmeldung erforderlich.', 401);
      const target = request.body.tenantId ?? null;

      if (target !== null) {
        const tenant = resolveTenant(target);
        if (!tenant) throw new AppError('tenant_not_found', 'Tenant not found.', 404);
        if (tenant.status === 'suspended') {
          throw new AppError('tenant_suspended', 'The tenant is suspended.', 403);
        }
      }

      const token = request.cookies[SESSION_COOKIE];
      const from = user.activeTenantId;
      if (!auth.setActiveTenant(token, target)) {
        throw new AppError('unauthorized', 'Anmeldung erforderlich.', 401);
      }
      if (from !== target) {
        auth.recordTenantSwitch({ userId: user.id, fromTenantId: from, toTenantId: target });
      }
      return authMeFor({ ...user, activeTenantId: target }, resolveTenant);
    },
  );

  app.post(
    '/auth/logout',
    {
      schema: {
        summary: 'End the current session',
        tags: ['auth'],
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      auth.destroySession(request.cookies[SESSION_COOKIE]);
      reply.clearCookie(SESSION_COOKIE, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: config.secureCookies,
      });
      reply.code(204).send();
    },
  );
}
