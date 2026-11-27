import { FieldError } from '../../shared/contract.ts';
import { decodeCursor, encodeCursor } from '../../kernel/cursor.ts';
import { AppError, invalidState, notFound } from '../../kernel/errors.ts';
import { newId } from '../../kernel/ids.ts';
import {
  DEPLOY_TARGETS,
  DOMAIN_PATTERN,
  EMAIL_PATTERN,
  MAX_NAME,
  MAX_PAGE_BODY,
  MAX_ROUTE,
  ROUTE_PATTERN,
  type ClientRow,
  type PageRow,
  type SiteRow,
  requireSite,
  siteDetail,
  uniqueSlug,
  validSlug,
} from './store.ts';
import { errorSchema, optionalText, parseLimit, type Runtime } from './runtime.ts';
import type { Delivery } from './delivery.ts';

export function registerSites(runtime: Runtime, delivery: Delivery): void {
  // --- Sites ---------------------------------------------------------------

  runtime.app.get<{
    Querystring: { status?: string; owner?: string; q?: string; limit?: string; cursor?: string };
  }>(
    '/websites',
    {
      preHandler: runtime.app.requireRole('tenant_admin', 'employee', 'operator'),
      schema: {
        summary: 'List websites with filters and keyset pagination',
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['draft', 'live', 'failed'] },
            owner: { type: 'string', enum: ['own', 'client'] },
            q: { type: 'string', maxLength: 80 },
            limit: { type: 'string' },
            cursor: { type: 'string' },
          },
        },
        response: { 401: errorSchema, 403: errorSchema },
      },
    },
    async (request) => {
      const database = runtime.tenantDatabase(request);
      const limit = parseLimit(request.query.limit);
      const where: string[] = [];
      const params: unknown[] = [];
      if (request.query.status) {
        where.push('status = ?');
        params.push(request.query.status);
      }
      if (request.query.owner === 'own') where.push('client_id is null');
      if (request.query.owner === 'client') where.push('client_id is not null');
      if (request.query.q) {
        const needle = `%${request.query.q.trim().toLowerCase()}%`;
        where.push(
          "(lower(name) like ? or lower(slug) like ? or lower(coalesce(domain, '')) like ?)",
        );
        params.push(needle, needle, needle);
      }
      const filter = where.length > 0 ? `where ${where.join(' and ')}` : '';
      const total = (
        database.prepare(`select count(*) as count from web_sites ${filter}`).get(...params) as {
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
      const rows = database
        .prepare(
          `select id, client_id, name, slug, status, astro_version, repo, branch, deploy_target,
                  domain, domain_state, internal_port, created_by, created_at, updated_at
             from web_sites ${pageFilter} order by created_at desc, id desc limit ?`,
        )
        .all(...pageParams, limit + 1) as SiteRow[];

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);
      return {
        items: page.map((row) => ({
          ...runtime.siteListItem(database, row),
          url: delivery.publicUrl(row),
        })),
        total,
        nextCursor:
          hasMore && last ? encodeCursor({ created_at: last.created_at, id: last.id }) : null,
      };
    },
  );

  runtime.app.get(
    '/websites/summary',
    {
      preHandler: runtime.app.requireRole('tenant_admin', 'employee', 'operator'),
      schema: { summary: 'Counts for the website dashboard' },
    },
    async (request) => {
      const database = runtime.tenantDatabase(request);
      // Expired links must not inflate the dashboard counts.
      database
        .prepare(
          `update web_approvals set state = 'expired', decided_at = ?
            where state = 'open' and expires_at < ?`,
        )
        .run(runtime.now().toISOString(), runtime.now().toISOString());
      const count = (sql: string, ...params: unknown[]) =>
        (database.prepare(sql).get(...params) as { count: number }).count;
      return {
        total: count('select count(*) as count from web_sites'),
        own: count('select count(*) as count from web_sites where client_id is null'),
        client: count('select count(*) as count from web_sites where client_id is not null'),
        live: count("select count(*) as count from web_sites where status = 'live'"),
        draft: count("select count(*) as count from web_sites where status = 'draft'"),
        failed: count("select count(*) as count from web_sites where status = 'failed'"),
        builds_running: count(
          "select count(*) as count from web_builds where status in ('queued','running')",
        ),
        approvals_open: count("select count(*) as count from web_approvals where state = 'open'"),
      };
    },
  );

  runtime.app.post<{
    Body: {
      name?: string;
      slug?: string;
      client_id?: string | null;
      domain?: string;
      repo?: string;
      branch?: string;
      deploy_target?: string;
    };
  }>(
    '/websites',
    {
      preHandler: runtime.app.requireRole('tenant_admin', 'employee', 'operator'),
      schema: {
        summary: 'Create a website record',
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 2, maxLength: MAX_NAME },
            slug: { type: 'string', maxLength: 48 },
            client_id: { type: ['string', 'null'] },
            domain: { type: 'string', maxLength: 253 },
            repo: { type: 'string', maxLength: 200 },
            branch: { type: 'string', maxLength: 120 },
            deploy_target: { type: 'string', enum: [...DEPLOY_TARGETS] },
          },
        },
        response: { 401: errorSchema, 403: errorSchema, 422: errorSchema },
      },
    },
    async (request, reply) => {
      const database = runtime.tenantDatabase(request);
      const fields: Record<string, string> = {};
      const name = (request.body.name ?? '').trim();
      if (name.length < 2) fields.name = 'Enter a name with at least two characters.';

      let clientId: string | null = null;
      if (request.body.client_id !== undefined && request.body.client_id !== null) {
        const client = database
          .prepare('select id from web_clients where id = ?')
          .get(request.body.client_id) as { id: string } | undefined;
        if (!client) fields.client_id = 'Unknown client.';
        else clientId = client.id;
      }

      const domain = optionalText(request.body.domain, 253)?.toLowerCase() ?? null;
      if (domain !== null && !DOMAIN_PATTERN.test(domain)) {
        fields.domain = 'Enter a domain such as example.de, without http://.';
      }

      let slug = (request.body.slug ?? '').trim();
      if (slug.length > 0 && !validSlug(slug)) {
        fields.slug = 'Lowercase letters, digits and single hyphens, 2–48 characters.';
      }
      if (Object.keys(fields).length > 0) throw new FieldError(fields);
      if (slug.length > 0) {
        const taken = database
          .prepare('select id from web_sites where slug = ? limit 1')
          .get(slug) as { id: string } | undefined;
        if (taken) {
          throw new FieldError({ slug: 'This slug is already taken.' });
        }
      }
      if (slug.length === 0) slug = uniqueSlug(database, name);

      const timestamp = runtime.now().toISOString();
      const id = newId('site');
      database
        .prepare(
          `insert into web_sites
             (id, client_id, name, slug, status, astro_version, repo, branch, deploy_target, domain,
              domain_state, created_by, created_at, updated_at)
           values (?, ?, ?, ?, 'draft', '5', ?, ?, ?, ?, 'unchecked', ?, ?, ?)`,
        )
        .run(
          id,
          clientId,
          name,
          slug,
          optionalText(request.body.repo, 200),
          optionalText(request.body.branch, 120),
          optionalText(request.body.deploy_target, 80) ?? 'tailscale',
          domain,
          request.user?.id ?? 'unknown',
          timestamp,
          timestamp,
        );

      const created = requireSite(database, id);
      // A site becomes reachable as soon as it exists: the preview link is the
      // first thing anyone opens, and it must not depend on a build.
      const withPort = delivery.ensure(runtime.tenantIdOf(request), created);
      reply.code(201);
      return { ...siteDetail(database, withPort), url: delivery.publicUrl(withPort) };
    },
  );

  runtime.app.get<{ Params: { siteId: string } }>(
    '/websites/:siteId',
    {
      preHandler: runtime.app.requireRole('tenant_admin', 'employee', 'operator'),
      schema: { summary: 'Website detail with client, build, release and approval state' },
    },
    async (request) => {
      const database = runtime.tenantDatabase(request);
      const site = requireSite(database, request.params.siteId);
      return { ...siteDetail(database, site), url: delivery.publicUrl(site) };
    },
  );

  runtime.app.patch<{
    Params: { siteId: string };
    Body: {
      name?: string;
      client_id?: string | null;
      domain?: string | null;
      repo?: string | null;
      branch?: string | null;
      deploy_target?: string | null;
    };
  }>(
    '/websites/:siteId',
    {
      preHandler: runtime.app.requireRole('tenant_admin', 'employee', 'operator'),
      schema: {
        summary: 'Update the editable fields of a website',
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 2, maxLength: MAX_NAME },
            client_id: { type: ['string', 'null'] },
            domain: { type: ['string', 'null'], maxLength: 253 },
            repo: { type: ['string', 'null'], maxLength: 200 },
            branch: { type: ['string', 'null'], maxLength: 120 },
            deploy_target: { type: ['string', 'null'], enum: [...DEPLOY_TARGETS, null] },
          },
        },
      },
    },
    async (request) => {
      const database = runtime.tenantDatabase(request);
      const site = requireSite(database, request.params.siteId);
      const fields: Record<string, string> = {};
      const updates: string[] = [];
      const values: unknown[] = [];

      if (request.body.name !== undefined) {
        const name = request.body.name.trim();
        if (name.length < 2) fields.name = 'Enter a name with at least two characters.';
        updates.push('name = ?');
        values.push(name);
      }
      if (request.body.client_id !== undefined) {
        if (request.body.client_id === null) {
          updates.push('client_id = null');
        } else {
          const client = database
            .prepare('select id from web_clients where id = ?')
            .get(request.body.client_id) as { id: string } | undefined;
          if (!client) fields.client_id = 'Unknown client.';
          updates.push('client_id = ?');
          values.push(request.body.client_id);
        }
      }
      if (request.body.domain !== undefined) {
        const domain = optionalText(request.body.domain, 253)?.toLowerCase() ?? null;
        if (domain !== null && !DOMAIN_PATTERN.test(domain)) {
          fields.domain = 'Enter a domain such as example.de, without http://.';
        }
        updates.push('domain = ?');
        values.push(domain);
      }
      for (const key of ['repo', 'branch'] as const) {
        if (request.body[key] !== undefined) {
          updates.push(`${key} = ?`);
          values.push(optionalText(request.body[key], 200));
        }
      }
      if (request.body.deploy_target !== undefined) {
        // `null` returns the site to the default delivery over the tailnet.
        updates.push('deploy_target = ?');
        values.push(request.body.deploy_target ?? 'tailscale');
      }
      if (Object.keys(fields).length > 0) throw new FieldError(fields);
      if (updates.length > 0) {
        updates.push('updated_at = ?');
        values.push(runtime.now().toISOString(), site.id);
        database.prepare(`update web_sites set ${updates.join(', ')} where id = ?`).run(...values);
      }
      const updated = requireSite(database, site.id);
      // A changed target moves the listener between the container interface and
      // loopback, so the port is re-bound here rather than at the next restart.
      const withPort = delivery.ensure(runtime.tenantIdOf(request), updated);
      return { ...siteDetail(database, withPort), url: delivery.publicUrl(withPort) };
    },
  );

  runtime.app.delete<{ Params: { siteId: string } }>(
    '/websites/:siteId',
    {
      preHandler: runtime.app.requireRole('tenant_admin', 'operator'),
      schema: { summary: 'Delete a website that was never published' },
    },
    async (request, reply) => {
      const database = runtime.tenantDatabase(request);
      const site = requireSite(database, request.params.siteId);
      const released = database
        .prepare('select id from web_releases where site_id = ? limit 1')
        .get(site.id) as { id: string } | undefined;
      if (released) {
        throw invalidState('A published website cannot be deleted. Archive it instead.');
      }
      database.prepare('delete from web_sites where id = ?').run(site.id);
      delivery.stop(site.id);
      return reply.code(204).send();
    },
  );

  // --- Clients -------------------------------------------------------------

  runtime.app.get<{ Querystring: { q?: string } }>(
    '/websites/clients',
    {
      preHandler: runtime.app.requireRole('tenant_admin', 'employee', 'operator'),
      schema: {
        summary: 'List clients of the agency',
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { q: { type: 'string', maxLength: 80 } },
        },
      },
    },
    async (request) => {
      const database = runtime.tenantDatabase(request);
      const rows = request.query.q
        ? (database
            .prepare('select * from web_clients where lower(name) like ? order by name limit 50')
            .all(`%${request.query.q.trim().toLowerCase()}%`) as ClientRow[])
        : (database
            .prepare('select * from web_clients order by name limit 50')
            .all() as ClientRow[]);
      return { items: rows, total: rows.length };
    },
  );

  runtime.app.post<{
    Body: { name?: string; contact_name?: string; contact_email?: string };
  }>(
    '/websites/clients',
    {
      preHandler: runtime.app.requireRole('tenant_admin', 'employee', 'operator'),
      schema: {
        summary: 'Create a client of the agency',
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 2, maxLength: MAX_NAME },
            contact_name: { type: 'string', maxLength: 120 },
            contact_email: { type: 'string', maxLength: 160 },
          },
        },
      },
    },
    async (request, reply) => {
      const database = runtime.tenantDatabase(request);
      const fields: Record<string, string> = {};
      const name = (request.body.name ?? '').trim();
      if (name.length < 2) fields.name = 'Enter a name with at least two characters.';
      const email = optionalText(request.body.contact_email, 160);
      if (email !== null && !EMAIL_PATTERN.test(email)) {
        fields.contact_email = 'Enter a valid email address.';
      }
      if (Object.keys(fields).length > 0) throw new FieldError(fields);

      const timestamp = runtime.now().toISOString();
      const id = newId('cli');
      database
        .prepare(
          `insert into web_clients (id, name, contact_name, contact_email, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, name, optionalText(request.body.contact_name, 120), email, timestamp, timestamp);
      reply.code(201);
      return database.prepare('select * from web_clients where id = ?').get(id);
    },
  );

  // --- Pages ---------------------------------------------------------------

  runtime.app.get<{ Params: { siteId: string } }>(
    '/websites/:siteId/pages',
    {
      preHandler: runtime.app.requireRole('tenant_admin', 'employee', 'operator'),
      schema: { summary: 'Pages of a website' },
    },
    async (request) => {
      const database = runtime.tenantDatabase(request);
      const site = requireSite(database, request.params.siteId);
      return { items: runtime.pageRows(database, site.id) };
    },
  );

  runtime.app.post<{
    Params: { siteId: string };
    Body: { route?: string; title?: string; body?: string };
  }>(
    '/websites/:siteId/pages',
    {
      preHandler: runtime.app.requireRole('tenant_admin', 'employee', 'operator'),
      schema: {
        summary: 'Add a page by hand',
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['route', 'title'],
          properties: {
            route: { type: 'string', maxLength: MAX_ROUTE },
            title: { type: 'string', minLength: 1, maxLength: MAX_NAME },
            body: { type: 'string', maxLength: MAX_PAGE_BODY },
          },
        },
      },
    },
    async (request, reply) => {
      const database = runtime.tenantDatabase(request);
      const site = requireSite(database, request.params.siteId);
      const route = (request.body.route ?? '').trim();
      const title = (request.body.title ?? '').trim();
      const fields: Record<string, string> = {};
      if (!ROUTE_PATTERN.test(route) || route.length > MAX_ROUTE) {
        fields.route = 'Start with "/", then lowercase segments such as /zimmer/suite.';
      }
      if (title.length === 0) fields.title = 'Enter a page title.';
      if (Object.keys(fields).length > 0) throw new FieldError(fields);

      const existing = database
        .prepare('select id from web_site_pages where site_id = ? and route = ?')
        .get(site.id, route) as { id: string } | undefined;
      if (existing) throw invalidState('This route already exists on the website.');

      const timestamp = runtime.now().toISOString();
      const id = newId('page');
      database
        .prepare(
          `insert into web_site_pages
             (id, site_id, route, title, origin, body_md, created_at, updated_at)
           values (?, ?, ?, ?, 'manual', ?, ?, ?)`,
        )
        .run(
          id,
          site.id,
          route,
          title,
          optionalText(request.body.body, MAX_PAGE_BODY),
          timestamp,
          timestamp,
        );
      reply.code(201);
      return database.prepare('select * from web_site_pages where id = ?').get(id);
    },
  );

  runtime.app.patch<{
    Params: { siteId: string; pageId: string };
    Body: { title?: string; body?: string | null };
  }>(
    '/websites/:siteId/pages/:pageId',
    {
      preHandler: runtime.app.requireRole('tenant_admin', 'employee', 'operator'),
      schema: {
        summary: 'Edit the title or the text of a page',
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', minLength: 1, maxLength: MAX_NAME },
            body: { type: ['string', 'null'], maxLength: MAX_PAGE_BODY },
          },
        },
      },
    },
    async (request) => {
      const database = runtime.tenantDatabase(request);
      const site = requireSite(database, request.params.siteId);
      const page = database
        .prepare('select * from web_site_pages where id = ? and site_id = ?')
        .get(request.params.pageId, site.id) as PageRow | undefined;
      if (!page) throw notFound('Page not found.');
      const updates: string[] = [];
      const values: unknown[] = [];
      if (request.body.title !== undefined) {
        updates.push('title = ?');
        values.push(request.body.title.trim());
      }
      if (request.body.body !== undefined) {
        updates.push('body_md = ?');
        values.push(optionalText(request.body.body, MAX_PAGE_BODY));
      }
      if (updates.length > 0) {
        updates.push('updated_at = ?');
        values.push(runtime.now().toISOString(), page.id);
        database
          .prepare(`update web_site_pages set ${updates.join(', ')} where id = ?`)
          .run(...values);
      }
      return database.prepare('select * from web_site_pages where id = ?').get(page.id);
    },
  );

  runtime.app.delete<{ Params: { siteId: string; pageId: string } }>(
    '/websites/:siteId/pages/:pageId',
    {
      preHandler: runtime.app.requireRole('tenant_admin', 'employee', 'operator'),
      schema: { summary: 'Remove a page from the draft' },
    },
    async (request, reply) => {
      const database = runtime.tenantDatabase(request);
      const site = requireSite(database, request.params.siteId);
      const removed = database
        .prepare('delete from web_site_pages where id = ? and site_id = ?')
        .run(request.params.pageId, site.id);
      if (removed.changes === 0) throw notFound('Page not found.');
      return reply.code(204).send();
    },
  );
}
