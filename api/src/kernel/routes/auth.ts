import type { FastifyInstance } from 'fastify';
import { FieldError, type AuthMe } from '../../shared/contract.ts';
import { SESSION_COOKIE, authMeFor } from '../app.ts';
import type { AuthService } from '../auth.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db.ts';
import { AppError } from '../errors.ts';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

const authMeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['user', 'tenant'],
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
    tenant: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['id', 'name', 'slug'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        slug: { type: 'string' },
      },
    },
  },
} as const;

/** Sliding-window-ish counter per sender, held in memory. A restart clears it. */
function createLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();

  const prune = (at: number): void => {
    const since = at - windowMs;
    for (const [key, times] of hits) {
      const fresh = times.filter((time) => time > since);
      if (fresh.length === 0) hits.delete(key);
      else hits.set(key, fresh);
    }
  };

  return (key: string, at: number): boolean => {
    // Bound the map: one entry per attacker-supplied key would otherwise grow
    // without limit. Pruning on every call keeps it at "keys active in the window".
    if (hits.size > 10_000) prune(at);
    const times = (hits.get(key) ?? []).filter((time) => time > at - windowMs);
    if (times.length >= limit) {
      hits.set(key, times);
      return false;
    }
    times.push(at);
    hits.set(key, times);
    return true;
  };
}

export interface AuthRouteOptions {
  auth: AuthService;
  config: Config;
  db: Db;
  now: () => Date;
  resolveTenant: (tenantId: string) => { id: string; name: string; slug: string } | null;
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  const { auth, config, now, resolveTenant } = options;
  const allowMagicLink = createLimiter(config.rateLimit.magicLink, 60_000);
  // A second, independent bucket per address: the per-IP limit alone is either
  // spoofable behind a trusted proxy or a shared bucket for every client, and in
  // both cases one address could be flooded.
  const allowMagicLinkForEmail = createLimiter(config.rateLimit.magicLink * 3, 15 * 60_000);

  app.post<{ Body: { email?: string } }>(
    '/auth/magic-link',
    {
      schema: {
        summary: 'Send a one-time sign-in link',
        tags: ['auth'],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email'],
          properties: { email: { type: 'string', minLength: 3, maxLength: 254 } },
        },
        response: {
          202: {
            type: 'object',
            additionalProperties: false,
            required: ['sent', 'expiresAt'],
            properties: {
              sent: { type: 'boolean' },
              expiresAt: { type: 'string' },
              // Only present when SF_DEV_MAGIC_LINK is on and the origin is not https.
              link: { type: 'string' },
              // Set when SF_DEV_AUTO_LOGIN is on as well: the page may spend
              // the link right away instead of asking for a click.
              autoLogin: { type: 'boolean' },
            },
          },
          422: errorSchema,
          429: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const email = (request.body.email ?? '').trim().toLowerCase();
      if (!EMAIL_PATTERN.test(email)) {
        throw new FieldError({ email: 'Please enter a valid email address.' });
      }
      const nowMs = now().getTime();
      if (
        config.rateLimit.enabled &&
        (!allowMagicLink(request.ip, nowMs) || !allowMagicLinkForEmail(email, nowMs))
      ) {
        throw new AppError(
          'rate_limited',
          'Too many sign-in attempts. Please try again in a minute.',
          429,
        );
      }

      const { link, expiresAt } = auth.createMagicLink(email);
      const user = options.db.prepare('select id from users where email = ?').get(email) as
        { id: string } | undefined;

      // Development only: the link is returned so the flow can be exercised
      // without a mail transport. Never for an unknown address, never over https.
      const expose = config.devMagicLink && user !== undefined;
      reply.code(202);
      if (!expose) return { sent: true, expiresAt };
      return config.devAutoLogin
        ? { sent: true, expiresAt, link, autoLogin: true }
        : { sent: true, expiresAt, link };
    },
  );

  app.post<{ Body: { token?: string } }>(
    '/auth/confirm',
    {
      schema: {
        summary: 'Exchange a magic-link token for a session cookie',
        tags: ['auth'],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['token'],
          properties: { token: { type: 'string', minLength: 10, maxLength: 200 } },
        },
        response: { 200: authMeSchema, 401: errorSchema },
      },
    },
    async (request, reply) => {
      let result: ReturnType<AuthService['consumeMagicLink']>;
      try {
        result = auth.consumeMagicLink(request.body.token ?? '', request.headers['user-agent']);
      } catch {
        throw new AppError('invalid_link', 'The sign-in link is invalid or has expired.', 401);
      }

      reply.setCookie(SESSION_COOKIE, result.sessionToken, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: config.secureCookies,
        maxAge: config.sessionTtlSeconds,
      });

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
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      reply.code(204).send();
    },
  );
}
