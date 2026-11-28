import { FieldError } from '../../shared/contract.ts';
import { AppError, invalidState, notFound } from '../../kernel/errors.ts';
import { newId } from '../../kernel/ids.ts';
import {
  MAX_NAME,
  MAX_ROUTE,
  ROUTE_PATTERN,
  type BuildRow,
  type JobRow,
  findBuild,
  isWorkActive,
  requireSite,
} from './store.ts';
import {
  MAX_JOB_GOAL,
  MAX_PAGES_PER_JOB,
  optionalText,
  parseLimit,
  tenantIdFromBody,
  type Runtime,
} from './runtime.ts';
import type { SiteBuilds } from './build-worker.ts';

export function registerPipeline(runtime: Runtime, builds: SiteBuilds): void {
  // --- Builds --------------------------------------------------------------

  runtime.app.get<{ Params: { siteId: string }; Querystring: { limit?: string } }>(
    '/websites/:siteId/builds',
    {
      preHandler: runtime.app.requireRole('tenant_admin', 'employee', 'operator'),
      schema: { summary: 'Build history of a website' },
    },
    async (request) => {
      const database = runtime.tenantDatabase(request);
      const site = requireSite(database, request.params.siteId);
      const limit = parseLimit(request.query.limit);
      const items = database
        .prepare(
          `select id, site_id, trigger, status, duration_ms, error_file, created_at, started_at,
                  finished_at
             from web_builds where site_id = ? order by created_at desc, id desc limit ?`,
        )
        .all(site.id, limit) as BuildRow[];
      return { items };
    },
  );

  runtime.app.post<{ Params: { siteId: string }; Body: { trigger?: string } }>(
    '/websites/:siteId/builds',
    {
      preHandler: runtime.app.requireRole('tenant_admin', 'employee', 'operator'),
      schema: {
        summary: 'Queue an Astro build',
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { trigger: { type: 'string', enum: ['manual', 'ai'] } },
        },
      },
    },
    async (request, reply) => {
      const database = runtime.tenantDatabase(request);
      const site = requireSite(database, request.params.siteId);
      const active = database
        .prepare(
          "select id from web_builds where site_id = ? and status in ('queued','running') limit 1",
        )
        .get(site.id) as { id: string } | undefined;
      if (active) throw invalidState('A build for this website is already running.');

      const id = newId('bld');
      database
        .prepare(
          `insert into web_builds (id, site_id, trigger, status, created_at)
           values (?, ?, ?, 'queued', ?)`,
        )
        .run(id, site.id, request.body.trigger ?? 'manual', runtime.now().toISOString());
      // The worker runs in this process, so queueing is enough: no poll interval
      // and no runner token are involved.
      builds.kick();
      reply.code(202);
      return database.prepare('select * from web_builds where id = ?').get(id);
    },
  );

  runtime.app.get<{ Params: { siteId: string; buildId: string } }>(
    '/websites/:siteId/builds/:buildId',
    {
      preHandler: runtime.app.requireRole('tenant_admin', 'employee', 'operator'),
      schema: { summary: 'One build with its log' },
    },
    async (request) => {
      const database = runtime.tenantDatabase(request);
      requireSite(database, request.params.siteId);
      const build = findBuild(database, request.params.siteId, request.params.buildId);
      if (!build) throw notFound('Build not found.');
      return build;
    },
  );

  runtime.app.post<{ Params: { siteId: string; buildId: string } }>(
    '/websites/:siteId/builds/:buildId/cancel',
    {
      preHandler: runtime.app.requireRole('tenant_admin', 'employee', 'operator'),
      schema: { summary: 'Cancel a queued or running build' },
    },
    async (request) => {
      const database = runtime.tenantDatabase(request);
      requireSite(database, request.params.siteId);
      const build = findBuild(database, request.params.siteId, request.params.buildId);
      if (!build) throw notFound('Build not found.');
      if (!isWorkActive(build.status)) throw invalidState('This build already finished.');
      database
        .prepare("update web_builds set status = 'cancelled', finished_at = ? where id = ?")
        .run(runtime.now().toISOString(), build.id);
      // The row is already final; this only stops the child from burning time.
      builds.cancel(build.id);
      return database.prepare('select * from web_builds where id = ?').get(build.id);
    },
  );

  /** The build runner reports back; only the process itself may call this. */
  runtime.app.post<{
    Params: { siteId: string; buildId: string };
    Body: {
      status?: string;
      log?: string;
      duration_ms?: number;
      error_file?: string;
    };
  }>(
    '/websites/:siteId/builds/:buildId/result',
    {
      preHandler: runtime.app.requireInternal,
      schema: {
        summary: 'Runner callback for a finished build',
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['status'],
          properties: {
            status: { type: 'string', enum: ['ok', 'failed'] },
            log: { type: 'string', maxLength: 20_000 },
            duration_ms: { type: 'integer', minimum: 0 },
            error_file: { type: 'string', maxLength: 300 },
          },
        },
      },
    },
    async (request) => {
      const database = runtime.tenantDb(tenantIdFromBody(request));
      requireSite(database, request.params.siteId);
      const build = findBuild(database, request.params.siteId, request.params.buildId);
      if (!build) throw notFound('Build not found.');
      // A runner callback that arrives after a cancel or a second callback must
      // not overwrite the finished state; the same guard protects jobs.
      if (!isWorkActive(build.status)) throw invalidState('This build already finished.');
      const timestamp = runtime.now().toISOString();
      const status = request.body.status as 'ok' | 'failed';
      database
        .prepare(
          `update web_builds
              set status = ?, log = ?, duration_ms = ?, error_file = ?,
                  started_at = coalesce(started_at, created_at), finished_at = ?
            where id = ?`,
        )
        .run(
          status,
          optionalText(request.body.log, 20_000),
          request.body.duration_ms ?? null,
          optionalText(request.body.error_file, 300),
          timestamp,
          build.id,
        );
      const released = database
        .prepare('select id from web_releases where site_id = ? limit 1')
        .get(build.site_id) as { id: string } | undefined;
      database
        .prepare('update web_sites set status = ?, updated_at = ? where id = ?')
        .run(status === 'ok' ? (released ? 'live' : 'draft') : 'failed', timestamp, build.site_id);
      return database.prepare('select * from web_builds where id = ?').get(build.id);
    },
  );

  // --- AI jobs -------------------------------------------------------------

  runtime.app.get<{ Params: { siteId: string } }>(
    '/websites/:siteId/jobs',
    {
      preHandler: runtime.app.requireRole('tenant_admin', 'employee', 'operator'),
      schema: { summary: 'AI drafts of a website' },
    },
    async (request) => {
      const database = runtime.tenantDatabase(request);
      const site = requireSite(database, request.params.siteId);
      const items = database
        .prepare(
          `select id, site_id, provider, model, tokens_in, tokens_out, cost_cents, status, error,
                  created_at, updated_at
             from web_ai_jobs where site_id = ? order by created_at desc, id desc limit 25`,
        )
        .all(site.id) as Omit<JobRow, 'brief_json' | 'plan_json'>[];
      return { items };
    },
  );

  runtime.app.post<{
    Params: { siteId: string };
    Body: {
      goal?: string;
      tone?: string;
      pages?: string[];
      sources?: string;
      provider?: string;
      model?: string;
      max_tokens?: number;
    };
  }>(
    '/websites/:siteId/jobs',
    {
      preHandler: runtime.app.requireRole('tenant_admin', 'employee', 'operator'),
      schema: {
        summary: 'Create an AI brief; a runner picks the queued job up',
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['goal'],
          properties: {
            goal: { type: 'string', minLength: 3, maxLength: MAX_JOB_GOAL },
            tone: { type: 'string', maxLength: 200 },
            pages: { type: 'array', maxItems: MAX_PAGES_PER_JOB, items: { type: 'string' } },
            sources: { type: 'string', maxLength: 2_000 },
            provider: { type: 'string', enum: ['anthropic', 'openai', 'local'] },
            model: { type: 'string', maxLength: 80 },
            max_tokens: { type: 'integer', minimum: 500, maximum: 200_000 },
          },
        },
      },
    },
    async (request, reply) => {
      const database = runtime.tenantDatabase(request);
      const site = requireSite(database, request.params.siteId);
      const current = runtime.settings(database);

      const fields: Record<string, string> = {};
      const goal = (request.body.goal ?? '').trim();
      if (goal.length < 3) fields.goal = 'Describe the purpose in at least three characters.';
      const pages = (request.body.pages ?? []).map((route) => route.trim());
      for (const route of pages) {
        if (!ROUTE_PATTERN.test(route) || route.length > MAX_ROUTE) {
          fields.pages = 'Routes start with "/" and use lowercase segments.';
          break;
        }
      }
      const maxTokens = request.body.max_tokens ?? current.max_tokens_per_run;
      if (maxTokens > current.max_tokens_per_run) {
        fields.max_tokens = `The tenant limit is ${current.max_tokens_per_run} tokens per run.`;
      }
      if (Object.keys(fields).length > 0) throw new FieldError(fields);

      const spent = (
        database
          .prepare(
            'select coalesce(sum(cost_cents), 0) as sum from web_ai_jobs where created_at >= ?',
          )
          .get(runtime.monthStart()) as { sum: number }
      ).sum;
      if (spent >= current.monthly_budget_cents) {
        throw new AppError(
          'budget_exhausted',
          'The monthly AI budget of this tenant is used up.',
          402,
        );
      }

      const timestamp = runtime.now().toISOString();
      const id = newId('job');
      const brief = {
        goal,
        tone: optionalText(request.body.tone, 200) ?? '',
        pages,
        sources: optionalText(request.body.sources, 2_000) ?? '',
        max_tokens: maxTokens,
      };
      database
        .prepare(
          `insert into web_ai_jobs
             (id, site_id, brief_json, provider, model, status, created_at, updated_at)
           values (?, ?, ?, ?, ?, 'queued', ?, ?)`,
        )
        .run(
          id,
          site.id,
          JSON.stringify(brief),
          request.body.provider ?? current.provider,
          request.body.model ?? current.model,
          timestamp,
          timestamp,
        );
      builds.kick();
      reply.code(202);
      return {
        id,
        site_id: site.id,
        status: 'queued',
        provider: request.body.provider ?? current.provider,
        model: request.body.model ?? current.model,
        brief,
        created_at: timestamp,
      };
    },
  );

  runtime.app.get<{ Params: { siteId: string; jobId: string } }>(
    '/websites/:siteId/jobs/:jobId',
    {
      preHandler: runtime.app.requireRole('tenant_admin', 'employee', 'operator'),
      schema: { summary: 'One AI job with its brief and plan' },
    },
    async (request) => {
      const database = runtime.tenantDatabase(request);
      requireSite(database, request.params.siteId);
      const job = database
        .prepare('select * from web_ai_jobs where id = ? and site_id = ?')
        .get(request.params.jobId, request.params.siteId) as JobRow | undefined;
      if (!job) throw notFound('AI job not found.');
      return job;
    },
  );

  runtime.app.post<{ Params: { siteId: string; jobId: string } }>(
    '/websites/:siteId/jobs/:jobId/cancel',
    {
      preHandler: runtime.app.requireRole('tenant_admin', 'employee', 'operator'),
      schema: { summary: 'Cancel a queued or running AI job' },
    },
    async (request) => {
      const database = runtime.tenantDatabase(request);
      requireSite(database, request.params.siteId);
      const job = database
        .prepare('select * from web_ai_jobs where id = ? and site_id = ?')
        .get(request.params.jobId, request.params.siteId) as JobRow | undefined;
      if (!job) throw notFound('AI job not found.');
      if (!isWorkActive(job.status)) throw invalidState('This job already finished.');
      database
        .prepare("update web_ai_jobs set status = 'cancelled', updated_at = ? where id = ?")
        .run(runtime.now().toISOString(), job.id);
      return database.prepare('select * from web_ai_jobs where id = ?').get(job.id);
    },
  );

  /** The AI runner reports the plan; only the process itself may call this. */
  runtime.app.post<{
    Params: { siteId: string; jobId: string };
    Body: {
      status?: string;
      plan?: { summary?: string; pages?: Array<{ route?: string; title?: string }> };
      tokens_in?: number;
      tokens_out?: number;
      cost_cents?: number;
      error?: string;
    };
  }>(
    '/websites/:siteId/jobs/:jobId/result',
    {
      preHandler: runtime.app.requireInternal,
      schema: {
        summary: 'Runner callback for a finished AI job',
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['status'],
          properties: {
            status: { type: 'string', enum: ['ok', 'failed'] },
            plan: {
              type: 'object',
              additionalProperties: false,
              properties: {
                summary: { type: 'string', maxLength: 1_000 },
                pages: {
                  type: 'array',
                  maxItems: MAX_PAGES_PER_JOB,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      route: { type: 'string', maxLength: MAX_ROUTE },
                      title: { type: 'string', maxLength: MAX_NAME },
                    },
                  },
                },
              },
            },
            tokens_in: { type: 'integer', minimum: 0 },
            tokens_out: { type: 'integer', minimum: 0 },
            cost_cents: { type: 'integer', minimum: 0 },
            error: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    async (request) => {
      // The callback carries no session: the tenant comes from the site lookup.
      const tenantId = tenantIdFromBody(request);
      const database = runtime.tenantDb(tenantId);
      requireSite(database, request.params.siteId);
      const job = database
        .prepare('select * from web_ai_jobs where id = ? and site_id = ?')
        .get(request.params.jobId, request.params.siteId) as JobRow | undefined;
      if (!job) throw notFound('AI job not found.');
      if (job.status !== 'queued' && job.status !== 'running') {
        throw invalidState('This job already finished.');
      }

      const timestamp = runtime.now().toISOString();
      const status = request.body.status as 'ok' | 'failed';
      const plan = status === 'ok' ? (request.body.plan ?? null) : null;
      if (status === 'ok' && plan?.pages) {
        for (const page of plan.pages) {
          if (!page.route || !ROUTE_PATTERN.test(page.route)) {
            throw new FieldError({ plan: 'The plan contains an invalid route.' });
          }
        }
      }

      database
        .prepare(
          `update web_ai_jobs
              set status = ?, plan_json = ?, tokens_in = ?, tokens_out = ?, cost_cents = ?,
                  error = ?, updated_at = ?
            where id = ?`,
        )
        .run(
          status,
          plan ? JSON.stringify(plan) : null,
          request.body.tokens_in ?? 0,
          request.body.tokens_out ?? 0,
          request.body.cost_cents ?? 0,
          status === 'failed' ? optionalText(request.body.error, 500) : null,
          timestamp,
          job.id,
        );

      if (status === 'ok' && plan?.pages) {
        for (const page of plan.pages) {
          if (!page.route || !page.title) continue;
          database
            .prepare(
              `insert into web_site_pages (id, site_id, route, title, origin, created_at, updated_at)
               values (?, ?, ?, ?, 'ai', ?, ?)
               on conflict(site_id, route) do update
                 set title = excluded.title, origin = 'ai', updated_at = excluded.updated_at`,
            )
            .run(newId('page'), job.site_id, page.route, page.title, timestamp, timestamp);
        }
        database
          .prepare('update web_sites set updated_at = ? where id = ?')
          .run(timestamp, job.site_id);
      }
      return database.prepare('select * from web_ai_jobs where id = ?').get(job.id);
    },
  );
}
