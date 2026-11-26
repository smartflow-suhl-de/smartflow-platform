import { FieldError, type Tenant, type TenantStatus } from '../../shared/contract.ts';
import type { PluginContext } from '../../kernel/context.ts';
import { AppError } from '../../kernel/errors.ts';
import { SLUG_PATTERN, newId, slugFrom } from '../../kernel/ids.ts';
import { manifest } from './manifest.ts';
import {
  decodeCursor,
  encodeCursor,
  toTenant,
  type TenantListQuery,
  type TenantRow,
} from './store.ts';

const tenantSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'slug', 'status', 'created_at'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    slug: { type: 'string' },
    status: { type: 'string', enum: ['active', 'suspended'] },
    created_at: { type: 'string' },
  },
} as const;

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
      },
    },
  },
} as const;

const listSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'total', 'nextCursor'],
  properties: {
    items: { type: 'array', items: tenantSchema },
    total: { type: 'integer' },
    nextCursor: { type: ['string', 'null'] },
  },
} as const;

const statsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['active', 'suspended', 'total'],
  properties: {
    active: { type: 'integer' },
    suspended: { type: 'integer' },
    total: { type: 'integer' },
  },
} as const;

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

function parseLimit(raw: unknown): number {
  const value = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, value));
}

function validateCreate(body: { name?: string; slug?: string }): { name: string; slug: string } {
  const fields: Record<string, string> = {};
  const name = (body.name ?? '').trim();
  const rawSlug = (body.slug ?? '').trim();

  if (name.length < 2 || name.length > 80) {
    fields.name = 'Please enter a name of 2 to 80 characters.';
  }

  let slug = rawSlug.length > 0 ? rawSlug : slugFrom(name);
  if (!SLUG_PATTERN.test(slug) || slug.length < 2 || slug.length > 48) {
    if (rawSlug.length > 0) {
      fields.slug = 'Lowercase letters, digits and hyphens only (2–48 characters).';
    } else {
      fields.slug = 'The name does not yield a valid slug. Please enter one manually.';
    }
    slug = '';
  }

  if (Object.keys(fields).length > 0) throw new FieldError(fields);
  return { name, slug };
}

export function register(ctx: PluginContext): void {
  const { app, db, log, now } = ctx;

  ctx.migrate([
    {
      version: 1,
      up(database) {
        database.exec(`
          create table tenants (
            id text primary key,
            name text not null,
            slug text not null unique,
            status text not null check (status in ('active', 'suspended')),
            created_at text not null,
            updated_at text not null
          );
          create index tenants_created on tenants(created_at, id);
          create index tenants_status on tenants(status);
        `);
      },
    },
  ]);

  /**
   * The tenant database is provisioned when the tenant is created, not on the
   * first read: a broken filesystem surface shows up at creation time. Tenant
   * tables are the plugin-scoped migrations registered here.
   */
  ctx.migrateTenant([
    {
      version: 1,
      up(database) {
        database.exec(`
          create table tenant_profile (
            id text primary key,
            display_name text not null,
            created_at text not null
          );
        `);
      },
    },
  ]);

  const findById = (id: string): TenantRow | undefined =>
    db.prepare('select id, name, slug, status, created_at from tenants where id = ?').get(id) as
      TenantRow | undefined;

  /** The kernel asks the owning plugin; it never reads this table itself. */
  ctx.provideTenantDirectory({
    resolve(tenantId) {
      const row = findById(tenantId);
      return row ? { id: row.id, name: row.name, slug: row.slug, status: row.status } : null;
    },
    list() {
      const rows = db
        .prepare('select id, name, slug, status, created_at from tenants order by name')
        .all() as TenantRow[];
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        status: row.status,
      }));
    },
  });

  function provision(tenant: TenantRow): void {
    const database = ctx.tenantDb(tenant.id);
    database
      .prepare(
        'insert or ignore into tenant_profile (id, display_name, created_at) values (?, ?, ?)',
      )
      .run(tenant.id, tenant.name, tenant.created_at);
  }

  app.get<{ Querystring: { status?: string; q?: string; limit?: string; cursor?: string } }>(
    '/tenants',
    {
      preHandler: app.requireRole('operator'),
      schema: {
        summary: 'List tenants with keyset pagination',
        tags: ['tenants'],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['active', 'suspended'] },
            q: { type: 'string', maxLength: 80 },
            limit: { type: 'string' },
            cursor: { type: 'string' },
          },
        },
        response: { 200: listSchema, 401: errorSchema, 403: errorSchema },
      },
    },
    async (request) => {
      const query: TenantListQuery = { limit: parseLimit(request.query.limit) };
      if (request.query.status) query.status = request.query.status as TenantStatus;
      if (request.query.q) query.q = request.query.q.trim();

      const where: string[] = [];
      const params: unknown[] = [];
      if (query.status) {
        where.push('status = ?');
        params.push(query.status);
      }
      if (query.q) {
        where.push('(lower(name) like ? or lower(slug) like ?)');
        const needle = `%${query.q.toLowerCase()}%`;
        params.push(needle, needle);
      }

      const filters = where.length > 0 ? `where ${where.join(' and ')}` : '';
      const total = (
        db.prepare(`select count(*) as count from tenants ${filters}`).get(...params) as {
          count: number;
        }
      ).count;

      let cursor = null;
      if (request.query.cursor) {
        cursor = decodeCursor(request.query.cursor);
        if (!cursor) throw new AppError('invalid_cursor', 'The cursor is invalid.', 400);
      }

      const pageWhere = [...where];
      const pageParams = [...params];
      if (cursor) {
        pageWhere.push('(created_at < ? or (created_at = ? and id < ?))');
        pageParams.push(cursor.created_at, cursor.created_at, cursor.id);
      }
      const pageFilter = pageWhere.length > 0 ? `where ${pageWhere.join(' and ')}` : '';

      const rows = db
        .prepare(
          `select id, name, slug, status, created_at from tenants ${pageFilter}
           order by created_at desc, id desc limit ?`,
        )
        .all(...pageParams, query.limit + 1) as TenantRow[];

      const hasMore = rows.length > query.limit;
      const page = hasMore ? rows.slice(0, query.limit) : rows;
      const last = page.at(-1);

      return {
        items: page.map(toTenant),
        total,
        nextCursor:
          hasMore && last ? encodeCursor({ created_at: last.created_at, id: last.id }) : null,
      };
    },
  );

  app.get(
    '/tenants/stats',
    {
      preHandler: app.requireRole('operator'),
      schema: {
        summary: 'Tenant counts for the overview',
        tags: ['tenants'],
        response: { 200: statsSchema, 401: errorSchema, 403: errorSchema },
      },
    },
    async () => {
      const rows = db
        .prepare('select status, count(*) as count from tenants group by status')
        .all() as {
        status: TenantStatus;
        count: number;
      }[];
      const counts = { active: 0, suspended: 0 };
      for (const row of rows) counts[row.status] = row.count;
      return { ...counts, total: counts.active + counts.suspended };
    },
  );

  app.post<{ Body: { name?: string; slug?: string } }>(
    '/tenants',
    {
      preHandler: app.requireRole('operator'),
      schema: {
        summary: 'Create a tenant and provision its database',
        tags: ['tenants'],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 80 },
            slug: { type: 'string', maxLength: 48 },
          },
        },
        response: {
          201: tenantSchema,
          401: errorSchema,
          403: errorSchema,
          409: errorSchema,
          422: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const { name, slug } = validateCreate(request.body);

      const taken = db.prepare('select id from tenants where slug = ?').get(slug) as
        { id: string } | undefined;
      if (taken) {
        throw new AppError('slug_taken', 'This slug is already taken.', 409, {
          fields: { slug: 'This slug is already taken.' },
        });
      }

      const createdAt = now().toISOString();
      const row: TenantRow = {
        id: newId('ten'),
        name,
        slug,
        status: 'active',
        created_at: createdAt,
      };

      db.prepare(
        'insert into tenants (id, name, slug, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)',
      ).run(row.id, row.name, row.slug, row.status, row.created_at, createdAt);

      try {
        provision(row);
      } catch (error) {
        // The tenant row is the source of truth; a failed database is visible
        // as a missing profile and reported, not silently ignored.
        log.error({ err: error, tenantId: row.id }, 'tenant database provisioning failed');
      }

      ctx.emit('tenant.created', { tenantId: row.id, name: row.name, slug: row.slug });
      reply.code(201);
      return toTenant(row);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/tenants/:id',
    {
      preHandler: app.requireRole('operator'),
      schema: {
        summary: 'Read one tenant',
        tags: ['tenants'],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        response: { 200: tenantSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema },
      },
    },
    async (request) => {
      const row = findById(request.params.id);
      if (!row) throw new AppError('tenant_not_found', 'Tenant not found.', 404);
      return toTenant(row);
    },
  );

  /** Reversible transition: repeating it is idempotent and emits nothing new. */
  function setStatus(id: string, status: TenantStatus): Tenant {
    const row = findById(id);
    if (!row) throw new AppError('tenant_not_found', 'Tenant not found.', 404);
    if (row.status === status) return toTenant(row);

    const updatedAt = now().toISOString();
    db.prepare('update tenants set status = ?, updated_at = ? where id = ?').run(
      status,
      updatedAt,
      id,
    );
    const updated: TenantRow = { ...row, status };
    ctx.emit(status === 'suspended' ? 'tenant.suspended' : 'tenant.resumed', { tenantId: id });
    return toTenant(updated);
  }

  app.post<{ Params: { id: string } }>(
    '/tenants/:id/suspend',
    {
      preHandler: app.requireRole('operator'),
      schema: {
        summary: 'Suspend a tenant; the process is reversible',
        tags: ['tenants'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: tenantSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema },
      },
    },
    async (request) => setStatus(request.params.id, 'suspended'),
  );

  app.post<{ Params: { id: string } }>(
    '/tenants/:id/resume',
    {
      preHandler: app.requireRole('operator'),
      schema: {
        summary: 'Resume a suspended tenant',
        tags: ['tenants'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: tenantSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema },
      },
    },
    async (request) => setStatus(request.params.id, 'active'),
  );

  log.debug(`${manifest.id} plugin registered`);
}

export default { manifest, register };
