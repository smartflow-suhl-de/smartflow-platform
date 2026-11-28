import type { FastifyInstance } from 'fastify';
import { fileURLToPath } from 'node:url';
import type { Db } from '../../kernel/db.ts';
import type { PluginContext } from '../../kernel/context.ts';
import type { SessionUser } from '../../kernel/auth.ts';
import { AppError, forbidden, unauthorized } from '../../kernel/errors.ts';
import { OWN_WORKSPACE_ID } from '../../shared/contract.ts';
import type { BuildRow, ClientRow, JobRow, PageRow, SettingsRow, SiteRow } from './store.ts';

export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 25;
export const DEFAULT_APPROVAL_DAYS = 14;
export const MAX_APPROVAL_DAYS = 60;
export const MAX_PAGES_PER_JOB = 40;
export const MAX_JOB_GOAL = 2_000;
/** A build that runs longer than this is killed; CI images differ by machine. */
export const DEFAULT_BUILD_TIMEOUT_MS = 120_000;
/** Finished builds kept per site; the release and open approval are exempt. */
export const DEFAULT_BUILD_KEEP = 3;

/**
 * Port assignment for the delivered sites. One site, one port, one origin: the
 * API keeps 8790, the sites start at 8801 and are only reachable through
 * `tailscale serve`, which maps them to ports 8443… on the node.
 *
 * The values are read here rather than in the kernel config because they belong
 * to this plugin's deployment shape and every other plugin runs fine without
 * them.
 */
export interface SitesConfig {
  enabled: boolean;
  host: string;
  portBase: number;
  portCount: number;
  tailnetPortBase: number;
}

function envInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function sitesConfig(config: PluginContext['config']): SitesConfig {
  const env = process.env;
  return {
    // Tests must not open ports; the same switch turns delivery off on a host
    // that only wants the panel.
    enabled: env.SF_SITES_ENABLED === '0' ? false : config.env !== 'test',
    host: env.SF_SITES_HOST ?? config.host,
    portBase: envInt(env.SF_SITES_PORT_BASE, 8801),
    portCount: envInt(env.SF_SITES_PORT_COUNT, 20),
    tailnetPortBase: envInt(env.SF_SITES_TAILNET_PORT_BASE, 8443),
  };
}

export const errorSchema = {
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
      },
    },
  },
} as const;

export function parseLimit(raw: unknown): number {
  const value = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, value));
}

export function optionalText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

/** Everything the route modules share: tenant access, settings and mapping. */
export interface Runtime {
  ctx: PluginContext;
  app: FastifyInstance;
  now(): Date;
  config: PluginContext['config'];
  log: PluginContext['log'];
  /** A tenant-scoped route has no meaning without the session's tenant. */
  tenantIdOf(request: { user: SessionUser | null }): string;
  /** Opens the verified tenant database and seeds its settings row. */
  tenantDatabase(request: { user: SessionUser | null }): Db;
  /** Opens a tenant database by id, for callbacks without a session. */
  tenantDb(tenantId: string): Db;
  settings(database: Db): SettingsRow;
  monthStart(): string;
  /** Template the build worker copies into a build directory. */
  templateDir: string;
  buildTimeoutMs: number;
  /** Finished builds kept per site; the release and open approvals are exempt. */
  buildKeepPerSite: number;
  sites: SitesConfig;
  /** Consumes one queued AI job; wired by `server.ts` to the AI worker. */
  runJob(tenantId: string, job: JobRow): Promise<void>;
  /** Called after a build changed the site status. */
  onBuildSettled?: (tenantId: string, siteId: string) => void;
  /** Called after an AI job wrote pages; the tenant names the database. */
  onJobSettled?: (tenantId: string, siteId: string) => void;
  clientName(database: Db, site: SiteRow): string | null;
  siteListItem(
    database: Db,
    site: SiteRow,
  ): SiteRow & {
    client_name: string | null;
    last_build: Pick<BuildRow, 'id' | 'status' | 'created_at' | 'duration_ms'> | null;
  };
  pageRows(database: Db, siteId: string): PageRow[];
}

export function createRuntime(ctx: PluginContext): Runtime {
  const { app, now } = ctx;

  function tenantIdOf(request: { user: SessionUser | null }): string {
    if (!request.user) throw unauthorized();
    // An operator without a chosen tenant works in the own workspace: the
    // agency's own sites are not a customer project and need no tenant.
    const tenantId =
      request.user.activeTenantId ??
      request.user.tenantId ??
      (request.user.role === 'operator' ? OWN_WORKSPACE_ID : null);
    if (!tenantId) throw forbidden('Select a tenant first.');
    return tenantId;
  }

  function tenantDatabase(request: { user: SessionUser | null }): Db {
    const database = ctx.tenantDb(tenantIdOf(request));
    database
      .prepare(
        `insert or ignore into web_settings
           (id, provider, model, max_tokens_per_run, max_cost_cents_per_run, monthly_budget_cents,
            require_approval, generate_images, updated_at)
         values (1, 'anthropic', 'standard', 25000, 100, 15000, 1, 0, ?)`,
      )
      .run(now().toISOString());
    return database;
  }

  function settings(database: Db): SettingsRow {
    return database.prepare('select * from web_settings where id = 1').get() as SettingsRow;
  }

  function monthStart(): string {
    const current = now();
    return new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1)).toISOString();
  }

  function clientName(database: Db, site: SiteRow): string | null {
    if (!site.client_id) return null;
    const row = database
      .prepare('select name from web_clients where id = ?')
      .get(site.client_id) as { name: string } | undefined;
    return row?.name ?? null;
  }

  function siteListItem(database: Db, site: SiteRow) {
    const lastBuild = database
      .prepare(
        `select id, status, created_at, duration_ms from web_builds
          where site_id = ? order by created_at desc, id desc limit 1`,
      )
      .get(site.id) as Pick<BuildRow, 'id' | 'status' | 'created_at' | 'duration_ms'> | undefined;
    return {
      ...site,
      client_name: clientName(database, site),
      last_build: lastBuild ?? null,
    };
  }

  function pageRows(database: Db, siteId: string): PageRow[] {
    return database
      .prepare('select * from web_site_pages where site_id = ? order by route, id')
      .all(siteId) as PageRow[];
  }

  return {
    ctx,
    app,
    now,
    config: ctx.config,
    log: ctx.log,
    tenantIdOf,
    tenantDatabase,
    tenantDb: (tenantId: string) => ctx.tenantDb(tenantId),
    settings,
    monthStart,
    clientName,
    siteListItem,
    pageRows,
    templateDir:
      process.env.SF_SITE_TEMPLATE ??
      fileURLToPath(new URL('../../../../templates/astro-site', import.meta.url)),
    buildTimeoutMs:
      Number.parseInt(process.env.SF_BUILD_TIMEOUT_MS ?? '', 10) || DEFAULT_BUILD_TIMEOUT_MS,
    buildKeepPerSite: Number.parseInt(process.env.SF_BUILD_KEEP ?? '', 10) || DEFAULT_BUILD_KEEP,
    sites: sitesConfig(ctx.config),
    async runJob() {
      throw new AppError('job_runner_missing', 'The AI worker is not configured.', 500);
    },
  };
}

/**
 * The runner callback has no session. The site belongs to exactly one tenant,
 * but finding it would require a cross-tenant scan, so the caller names the
 * tenant and the tenant database then proves the site exists there.
 */
export function tenantIdFromBody(request: {
  headers: Record<string, unknown>;
  params: unknown;
}): string {
  const header = request.headers['x-tenant-id'];
  if (typeof header === 'string' && header.length > 0) return header;
  const params = request.params as { tenantId?: string } | undefined;
  if (params?.tenantId) return params.tenantId;
  throw new AppError('tenant_required', 'The tenant is required.', 422);
}

export type { ClientRow, SettingsRow };
