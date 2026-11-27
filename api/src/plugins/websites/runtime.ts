import type { FastifyInstance } from 'fastify';
import type { Db } from '../../kernel/db.ts';
import type { PluginContext } from '../../kernel/context.ts';
import type { SessionUser } from '../../kernel/auth.ts';
import { AppError, forbidden, unauthorized } from '../../kernel/errors.ts';
import type { BuildRow, ClientRow, PageRow, SettingsRow, SiteRow } from './store.ts';

export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 25;
export const DEFAULT_APPROVAL_DAYS = 14;
export const MAX_APPROVAL_DAYS = 60;
export const MAX_PAGES_PER_JOB = 40;
export const MAX_JOB_GOAL = 2_000;

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
    const tenantId = request.user.activeTenantId ?? request.user.tenantId;
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
