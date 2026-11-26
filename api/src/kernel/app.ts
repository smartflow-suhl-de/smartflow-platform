import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
  type InjectOptions,
} from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FieldError,
  type AuthMe,
  type HealthResponse,
  type NavEntry,
  type NavResponse,
  type PluginManifest,
  type Role,
} from '../shared/contract.ts';
import { PLATFORM_VERSION } from '../shared/version.ts';
import { AuthService, type SessionUser } from './auth.ts';
import type { Config } from './config.ts';
import type { PluginContext, PluginModule, TenantDirectory } from './context.ts';
import { migrate, openDatabase, tenantDatabaseFile, type Db, type Migration } from './db.ts';
import { AppError, notFound, unauthorized } from './errors.ts';
import { EventBus } from './event-bus.ts';
import { newId } from './ids.ts';
import { generatedPlugins } from './plugin-registry.generated.ts';
import { platformMigrations } from './platform-migrations.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerNavRoutes } from './routes/nav.ts';

export const SESSION_COOKIE = 'sf_session';

/**
 * The header an in-process caller uses. A client that guesses it gains nothing
 * without the token, and the token never leaves the process.
 */
export const INTERNAL_TOKEN_HEADER = 'x-internal-token';
/** Who is calling, for the ledger. Set only alongside the token. */
export const INTERNAL_CALLER_HEADER = 'x-internal-caller';

export interface BuiltApp {
  app: FastifyInstance;
  config: Config;
  db: Db;
  auth: AuthService;
  /** Manifests in registration order — the nav route renders from these. */
  plugins: PluginManifest[];
  /**
   * Verified tenant database. Kernel-side jobs need the same boundary the
   * plugins get: unknown tenant → 404, suspended tenant → 403.
   */
  tenantDb(tenantId: string): Db;
  /**
   * The in-process caller token. Exposed so tests can exercise the internal
   * route path with the real value instead of disabling the check. Never send
   * it to a client, never log it.
   */
  internalToken: string;
}

export interface BuildOptions {
  config: Config;
  /** Test hook: replace the wall clock (magic link and session expiry). */
  now?: () => Date;
  /** Test hook: silence the logger regardless of config. */
  logger?: boolean;
}

/**
 * Builds the API without listening. Tests call this with their own data
 * directory and drive it through `app.inject`.
 */
export async function buildApp(options: BuildOptions): Promise<BuiltApp> {
  const { config } = options;
  const now = options.now ?? (() => new Date());

  const app = Fastify({
    logger:
      options.logger === false || config.logLevel === 'silent' ? false : { level: config.logLevel },
    bodyLimit: config.bodyLimit,
    // Only the hops we declare are trusted. `true` would trust the whole chain
    // and let a client set its own `request.ip` via `X-Forwarded-For`, which is
    // exactly what the magic-link rate limit keys on.
    trustProxy:
      config.trustProxy > 0 ? (_address: string, hop: number) => hop < config.trustProxy : false,
    genReqId: () => newId('req'),
  });

  const db = openDatabase(`${config.dataDir}/platform.sqlite`);
  migrate(db, platformMigrations);

  const eventBus = new EventBus(db, now, (error, event) => {
    app.log.error({ err: error, event }, 'event listener failed');
  });
  const auth = new AuthService(db, config, now, (name, payload) => eventBus.emit(name, payload));
  auth.seedOperator();
  auth.pruneSessions();

  await app.register(cookie);
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'API',
        description: 'Errors always use { error: { code, message, fields?, reason? } }.',
        version: PLATFORM_VERSION,
      },
      servers: [{ url: config.publicUrl }],
      // Plugin tags are not declared here: the kernel does not know plugin
      // names. Operations still carry them, they simply appear ungrouped.
      tags: [
        { name: 'platform', description: 'Health and generated documents' },
        { name: 'auth', description: 'Magic-link sign-in and session' },
        { name: 'nav', description: 'Navigation for the signed-in role' },
      ],
    },
  });

  app.decorateRequest('user', null);

  app.addHook('onRequest', async (request) => {
    request.user = auth.userForToken(request.cookies[SESSION_COOKIE]);
  });

  app.decorate('authenticate', async (request: { user: SessionUser | null }) => {
    if (!request.user) throw unauthorized();
  });

  /**
   * Proof of an in-process caller. Generated once per app, held only in memory
   * and only in the context, so no browser can produce it: it is never a
   * cookie, never in a response and never in the database. `timingSafeEqual`
   * keeps the comparison constant-time like the session lookup.
   */
  const internalToken = randomBytes(32).toString('hex');

  app.decorate('requireInternal', async (request: FastifyRequest) => {
    const given = request.headers[INTERNAL_TOKEN_HEADER];
    if (typeof given !== 'string') throw unauthorized();
    const a = Buffer.from(given, 'utf8');
    const b = Buffer.from(internalToken, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw unauthorized();
  });

  app.decorate(
    'requireRole',
    (...roles: Role[]) =>
      async (request: { user: SessionUser | null }) => {
        if (!request.user) throw unauthorized();
        if (!roles.includes(request.user.role)) {
          throw new AppError('forbidden', 'Forbidden.', 403);
        }
      },
  );

  app.setErrorHandler((rawError, request, reply) => {
    const error = rawError as FastifyError & { validation?: { instancePath?: string }[] };
    if (error instanceof AppError) {
      return reply.code(error.status).send(error.toBody());
    }
    if (error instanceof FieldError) {
      return reply.code(422).send({
        error: {
          code: error.code,
          message: 'Please check the highlighted fields.',
          fields: error.fields,
        },
      });
    }
    if (error.validation) {
      const fields: Record<string, string> = {};
      for (const issue of error.validation) {
        const path = (issue.instancePath ?? '').replace(/^\//, '').split('/').filter(Boolean);
        const key = path.at(-1) ?? 'form';
        fields[key] ??= 'Please enter a valid value.';
      }
      return reply.code(422).send({
        error: {
          code: 'validation_failed',
          message: 'Please check the highlighted fields.',
          fields: Object.keys(fields).length > 0 ? fields : { form: 'Please check your input.' },
        },
      });
    }
    const status = error.statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({
        error: { code: 'bad_request', message: 'The request could not be processed.' },
      });
    }
    request.log.error({ err: error }, 'unhandled request error');
    return reply.code(500).send({
      error: {
        code: 'internal_error',
        message: 'Unexpected error. Please try again later.',
      },
    });
  });

  // The shell is read once: it ships with the image and does not change while
  // the process runs, so a deep link never touches the filesystem.
  const spaIndex = config.webDir === null ? null : readSpaIndex(config.webDir);

  app.setNotFoundHandler((request, reply) => {
    // A browser navigation to a client-side route gets the SPA shell; the app
    // then renders the route itself. Only `GET` navigations qualify, and never
    // below `/api`: an unknown API route keeps the shared JSON error shape.
    if (
      spaIndex !== null &&
      (request.method === 'GET' || request.method === 'HEAD') &&
      acceptsHtml(request) &&
      !isApiPath(request.url)
    ) {
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        reply.header(name, value);
      }
      reply.type('text/html; charset=utf-8').send(spaIndex);
      return;
    }
    reply.code(404).send(notFound().toBody());
  });

  let tenantDirectory: TenantDirectory | null = null;
  const tenantMigrations = new Map<string, Migration[]>();
  const tenantCache = new Map<string, Db>();

  /** Opens a verified tenant database and applies every tenant migration once. */
  const tenantDb = (tenantId: string): Db => {
    const tenant = tenantDirectory?.resolve(tenantId) ?? null;
    if (!tenant) throw new AppError('tenant_not_found', 'Tenant not found.', 404);
    // A suspended tenant keeps its data but loses access — this is the kernel
    // boundary, so no plugin has to remember the check.
    if (tenant.status === 'suspended') {
      throw new AppError(
        'tenant_suspended',
        'The tenant is suspended. Data is accessible again after it is resumed.',
        403,
      );
    }
    const cached = tenantCache.get(tenant.id);
    if (cached) return cached;
    const opened = openDatabase(tenantDatabaseFile(config.dataDir, tenant.id));
    for (const [pluginId, migrations] of tenantMigrations) {
      migrate(opened, migrations, `tenant:${pluginId}`);
    }
    tenantCache.set(tenant.id, opened);
    return opened;
  };

  // A plugin may hold a handle across a suspension. Closing and dropping it here
  // means the next `tenantDb` call re-checks the status, so a suspended tenant
  // cannot keep reading through an older handle.
  eventBus.on('tenant.suspended', ({ tenantId }) => {
    const cached = tenantCache.get(tenantId);
    if (!cached) return;
    tenantCache.delete(tenantId);
    try {
      cached.close();
    } catch (error) {
      app.log.warn({ err: error, tenantId }, 'closing a suspended tenant database failed');
    }
  });

  const plugins: PluginManifest[] = [];

  for (const entry of generatedPlugins) {
    const module: PluginModule = (await entry.load()).default;
    const manifest = module.manifest;
    plugins.push(manifest);

    await app.register(
      async (scope) => {
        const ctx: PluginContext = {
          manifest,
          app: scope,
          config,
          db,
          log: scope.log,
          tenantDb,
          tenants() {
            return tenantDirectory?.list() ?? [];
          },
          provideTenantDirectory(directory) {
            tenantDirectory = directory;
          },
          migrate(migrations) {
            migrate(db, migrations, `plugin:${manifest.id}`);
          },
          migrateTenant(migrations) {
            tenantMigrations.set(manifest.id, [
              ...(tenantMigrations.get(manifest.id) ?? []),
              ...migrations,
            ]);
          },
          emit(name, payload) {
            eventBus.emit(name, payload);
          },
          on(name, handler) {
            eventBus.on(name, handler);
          },
          now,
          internalToken,
          async callInternal(caller, request) {
            // A plugin scope is mounted under /api/v1, so a relative url would
            // resolve inside that prefix. An absolute one reaches a sibling
            // plugin's route, which is the whole point: the kernel knows no
            // plugin names and this call does not need one.
            const options: InjectOptions = {
              method: request.method,
              url: request.url,
              headers: {
                [INTERNAL_TOKEN_HEADER]: internalToken,
                [INTERNAL_CALLER_HEADER]: caller,
              },
            };
            if (request.payload !== undefined && request.payload !== null) {
              options.payload = request.payload;
            }
            const response = await app.inject(options);
            return { status: response.statusCode, body: response.body };
          },
        };
        await module.register(ctx);
      },
      { prefix: '/api/v1' },
    );
  }

  await app.register(
    async (scope) => {
      registerAuthRoutes(scope, {
        auth,
        config,
        db,
        now,
        resolveTenant: (tenantId) => tenantDirectory?.resolve(tenantId) ?? null,
      });
      registerNavRoutes(scope, { plugins });

      scope.get(
        '/health',
        {
          schema: {
            summary: 'Liveness and build identity of the running API',
            tags: ['platform'],
            response: {
              200: {
                type: 'object',
                additionalProperties: false,
                required: ['status', 'version', 'port'],
                properties: {
                  status: { type: 'string', enum: ['ok', 'degraded'] },
                  version: { type: 'string' },
                  port: { type: ['integer', 'null'] },
                },
              },
            },
          },
        },
        async (): Promise<HealthResponse> => ({
          status: 'ok',
          version: PLATFORM_VERSION,
          port: config.port,
        }),
      );
    },
    { prefix: '/api/v1' },
  );

  app.get(
    '/api/openapi.json',
    { schema: { hide: true }, preHandler: app.authenticate },
    async (_request, reply) => {
      reply.type('application/json');
      return app.swagger();
    },
  );

  // `wildcard: false` registers one route per existing file instead of a
  // `/*` sink. A request can therefore only ever name a file that was in the
  // build at startup, which rules out traversal without a path check of our own.
  if (config.webDir !== null) {
    await app.register(fastifyStatic, {
      root: config.webDir,
      wildcard: false,
      setHeaders(reply) {
        for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
          reply.header(name, value);
        }
      },
    });
  }

  app.addHook('onClose', async () => {
    for (const database of tenantCache.values()) database.close();
    tenantCache.clear();
    db.close();
  });

  return { app, config, db, auth, plugins, tenantDb, internalToken };
}

/** The built SPA shell, or `null` when `webDir` carries no `index.html`. */
function readSpaIndex(webDir: string): string | null {
  try {
    return readFileSync(join(webDir, 'index.html'), 'utf8');
  } catch (error) {
    // A missing build is an API-only start, which is a supported mode. Anything
    // else (a wrong owner, a broken mount) must fail loudly instead of turning
    // every deep link into a 404.
    if ((error as { code?: string }).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Whether a client asked for a document rather than for data. The header is
 * case-insensitive and `text/html;q=0` explicitly refuses HTML, so a plain
 * substring test would answer both wrong.
 */
function acceptsHtml(request: FastifyRequest): boolean {
  const accept = request.headers.accept;
  if (typeof accept !== 'string') return false;
  return accept
    .toLowerCase()
    .split(',')
    .map((part) => part.trim().split(';'))
    .some(([type, ...params]) => {
      if (type?.trim() !== 'text/html') return false;
      const q = params.find((param) => param.trim().startsWith('q='));
      return q === undefined || Number.parseFloat(q.split('=')[1] ?? '1') > 0;
    });
}

/**
 * Headers a served document needs and an API answer does not. Kept small on
 * purpose: the SPA ships no inline script, so a strict policy holds today.
 * `style-src` allows inline styles because the bundle sets CSS custom
 * properties from JavaScript.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

/** `/api` and everything below it belongs to the API, never to the SPA. */
function isApiPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return path === '/api' || path.startsWith('/api/');
}

/** Nav entries from manifests, filtered for the role, in display order. */
export function navFor(plugins: PluginManifest[], role: Role): NavResponse {
  const items: NavEntry[] = plugins
    .filter((manifest) => manifest.nav)
    .map((manifest) => {
      const nav = manifest.nav as NonNullable<PluginManifest['nav']>;
      return {
        plugin: manifest.id,
        label: nav.label,
        path: nav.path,
        group: nav.group,
        icon: nav.icon,
        order: nav.order ?? 100,
        roles: nav.roles ?? ['operator'],
        createLabel: nav.createLabel ?? null,
        aliases: nav.aliases ?? [],
      };
    })
    .filter((entry) => entry.roles.includes(role))
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label, 'de'));
  return { items };
}

/** Resolves the tenant a signed-in user belongs to, for `AuthMe`. */
export function authMeFor(
  user: SessionUser,
  resolveTenant: (tenantId: string) => { id: string; name: string; slug: string } | null,
): AuthMe {
  const tenant = user.tenantId ? resolveTenant(user.tenantId) : null;
  return {
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    tenant: tenant ? { id: tenant.id, name: tenant.name, slug: tenant.slug } : null,
  };
}
