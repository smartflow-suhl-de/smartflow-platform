import { FieldError, type Tenant, type TenantStatus } from '../../shared/contract.ts';
import type { PluginContext, TenantRef } from '../../kernel/context.ts';
import { AppError } from '../../kernel/errors.ts';
import { SLUG_PATTERN, newId, slugFrom } from '../../kernel/ids.ts';
import { manifest } from './manifest.ts';
import {
  DETAIL_FIELDS,
  DETAIL_SELECT,
  decodeCursor,
  emptyDetails,
  encodeCursor,
  toTenant,
  type DetailField,
  type TenantListQuery,
  type TenantRow,
} from './store.ts';

/** Max length per master-data field; the browser enforces the same numbers. */
const DETAIL_LIMITS: Record<DetailField, number> = {
  legal_name: 160,
  legal_form: 60,
  customer_number: 40,
  industry: 80,
  street: 120,
  address_extra: 120,
  postal_code: 12,
  city: 80,
  country: 60,
  contact_name: 120,
  contact_role: 80,
  contact_email: 160,
  contact_phone: 40,
  contact_mobile: 40,
  email: 160,
  phone: 40,
  website: 160,
  vat_id: 32,
  tax_number: 32,
  register_court: 80,
  register_number: 60,
  notes: 2000,
};

const EMAIL_FIELDS = new Set<DetailField>(['contact_email', 'email']);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const POSTAL_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 -]{0,11}$/;

const detailProperties = Object.fromEntries(
  DETAIL_FIELDS.map((field) => [
    field,
    { type: ['string', 'null'], maxLength: DETAIL_LIMITS[field] },
  ]),
);

const detailsSchema = {
  type: 'object',
  additionalProperties: false,
  required: [...DETAIL_FIELDS],
  properties: Object.fromEntries(
    DETAIL_FIELDS.map((field) => [field, { type: ['string', 'null'] }]),
  ),
} as const;

const tenantSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'slug', 'status', 'created_at', 'details'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    slug: { type: 'string' },
    status: { type: 'string', enum: ['active', 'suspended'] },
    created_at: { type: 'string' },
    details: detailsSchema,
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

/**
 * Trims and validates the provided master-data fields. Absent keys stay
 * untouched (a PATCH that only changes the phone number must not wipe the
 * address); an empty string clears the field to `null`.
 */
function validateDetails(
  body: Record<string, unknown>,
): Partial<Record<DetailField, string | null>> {
  const fields: Record<string, string> = {};
  const values: Partial<Record<DetailField, string | null>> = {};

  for (const field of DETAIL_FIELDS) {
    if (!(field in body)) continue;
    const raw = body[field];
    if (raw === null || raw === undefined) {
      values[field] = null;
      continue;
    }
    if (typeof raw !== 'string') {
      fields[field] = 'Please enter text.';
      continue;
    }
    const value = raw.trim();
    if (value.length === 0) {
      values[field] = null;
      continue;
    }
    if (value.length > DETAIL_LIMITS[field]) {
      fields[field] = `Please use at most ${DETAIL_LIMITS[field]} characters.`;
      continue;
    }
    if (EMAIL_FIELDS.has(field) && !EMAIL_PATTERN.test(value)) {
      fields[field] = 'Please enter a valid email address.';
      continue;
    }
    if (field === 'postal_code' && !POSTAL_CODE_PATTERN.test(value)) {
      fields[field] = 'Please enter a valid postal code.';
      continue;
    }
    values[field] = value;
  }

  if (Object.keys(fields).length > 0) throw new FieldError(fields);
  return values;
}

function validateName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name.length < 2 || name.length > 80) {
    throw new FieldError({ name: 'Please enter a name of 2 to 80 characters.' });
  }
  return name;
}

function validateSlug(raw: unknown): string {
  const slug = typeof raw === 'string' ? raw.trim() : '';
  if (!SLUG_PATTERN.test(slug) || slug.length < 2 || slug.length > 48) {
    throw new FieldError({
      slug: 'Lowercase letters, digits and hyphens only (2–48 characters).',
    });
  }
  return slug;
}

const slugTaken = () =>
  new AppError('slug_taken', 'This slug is already taken.', 409, {
    fields: { slug: 'This slug is already taken.' },
  });

/**
 * A slug can be taken between the pre-check and the write when two processes
 * share the SQLite file; the unique index then raises a constraint error. Both
 * come out as 409 so the client sees one answer.
 */
function isSlugConstraint(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    (error as { code: string }).code.startsWith('SQLITE_CONSTRAINT')
  );
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
    {
      version: 2,
      up(database) {
        // Master data of the tenant itself, kept next to the row because the
        // operator directory lists and edits it before a tenant context exists.
        for (const field of DETAIL_FIELDS) {
          database.exec(`alter table tenants add column ${field} text`);
        }
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
    {
      version: 2,
      up(database) {
        // The tenant's own database keeps a copy of its master data so
        // tenant-scoped plugins can read the address without the platform DB.
        for (const field of DETAIL_FIELDS) {
          database.exec(`alter table tenant_profile add column ${field} text`);
        }
      },
    },
  ]);

  const findById = (id: string): TenantRow | undefined =>
    db
      .prepare(
        `select id, name, slug, status, created_at, ${DETAIL_SELECT} from tenants where id = ?`,
      )
      .get(id) as TenantRow | undefined;

  /** The kernel asks the owning plugin; it never reads this table itself. */
  ctx.provideTenantDirectory({
    resolve(tenantId) {
      const row = findById(tenantId);
      return row ? { id: row.id, name: row.name, slug: row.slug, status: row.status } : null;
    },
    list() {
      // `TenantRef` on purpose: the kernel directory needs no master data, and
      // the detail columns are not selected here.
      const rows = db
        .prepare('select id, name, slug, status from tenants order by name')
        .all() as TenantRef[];
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        status: row.status,
      }));
    },
  });

  /**
   * The agent asks these two questions instead of reading the tenant table.
   * Both are read-only and return only what an operator may see; the
   * arguments are validated by the agent against the schema below.
   */
  ctx.provideAgentSource({
    id: 'tenants.summary',
    readOnly: true,
    label: 'Mandanten',
    description: 'Anzahl aller, aktiver und gesperrter Mandanten.',
    args: { type: 'object', additionalProperties: false, properties: {} },
    href: '/tenants',
    run: async () => {
      const rows = db
        .prepare('select status, count(*) as count from tenants group by status')
        .all() as { status: TenantStatus; count: number }[];
      const counts = { active: 0, suspended: 0 };
      for (const row of rows) counts[row.status] = row.count;
      return { ...counts, total: counts.active + counts.suspended };
    },
  });

  ctx.provideAgentSource({
    id: 'tenants.list',
    readOnly: true,
    label: 'Mandantenliste',
    description: 'Mandanten mit Slug, Status und Anlagedatum; filterbar nach Status und Name.',
    args: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['active', 'suspended'] },
        q: { type: 'string', maxLength: 80 },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
      },
    },
    href: '/tenants',
    run: async (args) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (args.status === 'active' || args.status === 'suspended') {
        where.push('status = ?');
        params.push(args.status);
      }
      if (typeof args.q === 'string' && args.q.trim().length > 0) {
        where.push("(lower(name) like ? escape '\\' or lower(slug) like ? escape '\\')");
        // `%`, `_` and `\` in the search text are literals, not wildcards.
        const needle = `%${args.q
          .trim()
          .toLowerCase()
          .replace(/[\\%_]/g, '\\$&')}%`;
        params.push(needle, needle);
      }
      const limit = typeof args.limit === 'number' ? Math.min(20, Math.max(1, args.limit)) : 10;
      const rows = db
        .prepare(
          `select name, slug, status, created_at from tenants
           ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
           order by created_at desc, id desc limit ?`,
        )
        .all(...params, limit) as {
        name: string;
        slug: string;
        status: TenantStatus;
        created_at: string;
      }[];
      return { items: rows, shown: rows.length };
    },
  });

  function provision(tenant: TenantRow): void {
    const database = ctx.tenantDb(tenant.id);
    const columns = ['id', 'display_name', 'created_at', ...DETAIL_FIELDS];
    const placeholders = columns.map(() => '?').join(', ');
    const values = [
      tenant.id,
      tenant.name,
      tenant.created_at,
      ...DETAIL_FIELDS.map((field) => tenant[field]),
    ];
    database
      .prepare(
        `insert or ignore into tenant_profile (${columns.join(', ')}) values (${placeholders})`,
      )
      .run(...values);
  }

  /**
   * Mirrors the platform row into the tenant database. Returns `false` when the
   * tenant database cannot be opened — a suspended tenant has no handle — so
   * the caller knows the copy is behind. The platform row stays the source of
   * truth; `setStatus(..., 'active')` replays the sync on resume.
   */
  function syncProfile(tenant: TenantRow): boolean {
    try {
      const database = ctx.tenantDb(tenant.id);
      const assignments = ['display_name = ?', ...DETAIL_FIELDS.map((field) => `${field} = ?`)];
      const values = [tenant.name, ...DETAIL_FIELDS.map((field) => tenant[field]), tenant.id];
      const changed = database
        .prepare(`update tenant_profile set ${assignments.join(', ')} where id = ?`)
        .run(...values);
      if (changed.changes === 0) provision(tenant);
      return true;
    } catch (error) {
      // Only the tenant boundary may fail here; anything else is a real bug.
      if (!(error instanceof AppError) || error.code !== 'tenant_suspended') throw error;
      log.debug({ tenantId: tenant.id }, 'tenant profile sync deferred until resume');
      return false;
    }
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
          `select id, name, slug, status, created_at, ${DETAIL_SELECT} from tenants ${pageFilter}
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

  app.post<{ Body: Record<string, unknown> }>(
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
            ...detailProperties,
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
      if (taken) throw slugTaken();

      const details = validateDetails(request.body);

      const createdAt = now().toISOString();
      const row: TenantRow = {
        id: newId('ten'),
        name,
        slug,
        status: 'active',
        created_at: createdAt,
        ...emptyDetails(),
        ...details,
      };

      const columns = [
        'id',
        'name',
        'slug',
        'status',
        'created_at',
        'updated_at',
        ...DETAIL_FIELDS,
      ];
      const placeholders = columns.map(() => '?').join(', ');
      try {
        db.prepare(`insert into tenants (${columns.join(', ')}) values (${placeholders})`).run(
          row.id,
          row.name,
          row.slug,
          row.status,
          row.created_at,
          createdAt,
          ...DETAIL_FIELDS.map((field) => row[field]),
        );
      } catch (error) {
        if (isSlugConstraint(error)) throw slugTaken();
        throw error;
      }

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

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/tenants/:id',
    {
      preHandler: app.requireRole('operator'),
      schema: {
        summary: 'Update a tenant name and master data',
        tags: ['tenants'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 80 },
            slug: { type: 'string', minLength: 2, maxLength: 48 },
            ...detailProperties,
          },
        },
        response: {
          200: tenantSchema,
          401: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
          422: errorSchema,
        },
      },
    },
    async (request) => {
      const row = findById(request.params.id);
      if (!row) throw new AppError('tenant_not_found', 'Tenant not found.', 404);

      const details = validateDetails(request.body);
      const name = 'name' in request.body ? validateName(request.body.name) : row.name;
      const slug = 'slug' in request.body ? validateSlug(request.body.slug) : row.slug;

      if (slug !== row.slug) {
        const taken = db
          .prepare('select id from tenants where slug = ? and id <> ?')
          .get(slug, row.id) as { id: string } | undefined;
        if (taken) throw slugTaken();
      }

      const assignments: string[] = ['name = ?', 'slug = ?', 'updated_at = ?'];
      const values: unknown[] = [name, slug, now().toISOString()];
      const changedFields: string[] = [];
      if (name !== row.name) changedFields.push('name');
      if (slug !== row.slug) changedFields.push('slug');
      for (const field of DETAIL_FIELDS) {
        if (!(field in details)) continue;
        assignments.push(`${field} = ?`);
        values.push(details[field] ?? null);
        if ((details[field] ?? null) !== row[field]) changedFields.push(field);
      }
      values.push(row.id);

      try {
        db.prepare(`update tenants set ${assignments.join(', ')} where id = ?`).run(...values);
      } catch (error) {
        if (isSlugConstraint(error)) throw slugTaken();
        throw error;
      }

      const updated: TenantRow = { ...row, name, slug, ...details };
      syncProfile(updated);
      // Field names only: the audit log records that master data changed, never
      // the values. A patch that changes nothing emits nothing.
      if (changedFields.length > 0)
        ctx.emit('tenant.updated', { tenantId: row.id, fields: changedFields });
      return toTenant(updated);
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
    // The tenant database is unreachable while suspended, so a master-data
    // change made in the meantime is replayed here. `syncProfile` updates the
    // row and inserts it when it is still missing.
    if (status === 'active') syncProfile(updated);
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
