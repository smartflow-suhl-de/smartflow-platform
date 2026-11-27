import { FieldError } from '../../shared/contract.ts';
import { hashToken } from '../../kernel/crypto.ts';
import { AppError, invalidState, notFound } from '../../kernel/errors.ts';
import { newId, token } from '../../kernel/ids.ts';
import type { FastifyReply } from 'fastify';
import {
  type ApprovalRow,
  type ApprovalState,
  type BuildRow,
  findBuild,
  requireSite,
} from './store.ts';
import { DEFAULT_APPROVAL_DAYS, MAX_APPROVAL_DAYS, optionalText, type Runtime } from './runtime.ts';

export function registerApprovals(runtime: Runtime): void {
  // Public links are open to the internet; the token is the only credential.
  // One key per sender and token keeps a leaked link from being hammered.
  const PUBLIC_LIMIT_PER_MINUTE = 120;
  const PUBLIC_MAX_KEYS = 2_000;
  const PUBLIC_PRUNE_MS = 30_000;
  const publicWindows = new Map<string, number[]>();
  let lastPrune = 0;
  function allowPublic(key: string): boolean {
    const now = runtime.now().getTime();
    if (now - lastPrune >= PUBLIC_PRUNE_MS) {
      lastPrune = now;
      for (const [entry, stamps] of publicWindows) {
        if (stamps.every((stamp) => now - stamp >= 60_000)) publicWindows.delete(entry);
      }
    }
    const recent = (publicWindows.get(key) ?? []).filter((stamp) => now - stamp < 60_000);
    if (recent.length >= PUBLIC_LIMIT_PER_MINUTE) {
      publicWindows.set(key, recent);
      return false;
    }
    recent.push(now);
    // Insertion order doubles as LRU order, so the map never grows unbounded.
    publicWindows.delete(key);
    publicWindows.set(key, recent);
    while (publicWindows.size > PUBLIC_MAX_KEYS) {
      const oldest = publicWindows.keys().next().value;
      if (oldest === undefined) break;
      publicWindows.delete(oldest);
    }
    return true;
  }
  /** Public answers carry no cache and no index hint, like the discovery link. */
  function publicHeaders(reply: FastifyReply): void {
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-robots-tag', 'noindex, nofollow');
    reply.header('x-content-type-options', 'nosniff');
  }

  function publicGuard(tenantId: string, plaintext: string, ip: string): void {
    // A coarse per-IP cap stops token rotation from bypassing the per-token one.
    if (!allowPublic(`ip:${ip}`)) {
      throw new AppError('rate_limited', 'Too many requests. Please wait a moment.', 429);
    }
    if (!allowPublic(`${tenantId}:${hashToken(plaintext).slice(0, 16)}:${ip}`)) {
      throw new AppError('rate_limited', 'Too many requests. Please wait a moment.', 429);
    }
  }

  // --- Approvals -----------------------------------------------------------

  runtime.app.get<{ Params: { siteId: string } }>(
    '/websites/:siteId/approvals',
    {
      preHandler: runtime.app.requireRole('tenant_admin', 'employee', 'operator'),
      schema: { summary: 'Approval links of a website' },
    },
    async (request) => {
      const database = runtime.tenantDatabase(request);
      const site = requireSite(database, request.params.siteId);
      // Expired links must not stay "open" in the counts just because nobody
      // opened them; persist the state on read, like the public route does.
      database
        .prepare(
          `update web_approvals set state = 'expired', decided_at = ?
            where site_id = ? and state = 'open' and expires_at < ?`,
        )
        .run(runtime.now().toISOString(), site.id, runtime.now().toISOString());
      const items = database
        .prepare(
          `select id, site_id, build_id, recipient, state, comment, expires_at, decided_at,
                  created_at
             from web_approvals where site_id = ? order by created_at desc, id desc limit 25`,
        )
        .all(site.id);
      return { items };
    },
  );

  runtime.app.post<{
    Params: { siteId: string };
    Body: { build_id?: string; recipient?: string; expires_in_days?: number };
  }>(
    '/websites/:siteId/approvals',
    {
      preHandler: runtime.app.requireRole('tenant_admin', 'employee', 'operator'),
      schema: {
        summary: 'Create a one-time approval link for a finished build',
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['build_id'],
          properties: {
            build_id: { type: 'string' },
            recipient: { type: 'string', maxLength: 160 },
            expires_in_days: { type: 'integer', minimum: 1, maximum: MAX_APPROVAL_DAYS },
          },
        },
      },
    },
    async (request, reply) => {
      const database = runtime.tenantDatabase(request);
      const tenantId = runtime.tenantIdOf(request);
      const site = requireSite(database, request.params.siteId);
      const build = findBuild(database, site.id, request.body.build_id ?? '');
      if (!build) throw notFound('Build not found.');
      if (build.status !== 'ok') {
        throw invalidState('Only a successful build can be sent for approval.');
      }
      const days = request.body.expires_in_days ?? DEFAULT_APPROVAL_DAYS;
      const plaintext = token(24);
      const id = newId('apr');
      const createdAt = runtime.now();
      const expiresAt = new Date(createdAt.getTime() + days * 86_400_000).toISOString();
      database
        .prepare(
          `insert into web_approvals
             (id, site_id, build_id, token_hash, recipient, state, expires_at, created_at)
           values (?, ?, ?, ?, ?, 'open', ?, ?)`,
        )
        .run(
          id,
          site.id,
          build.id,
          hashToken(plaintext),
          optionalText(request.body.recipient, 160),
          expiresAt,
          createdAt.toISOString(),
        );
      reply.code(201);
      const stored = database
        .prepare(
          `select id, site_id, build_id, recipient, state, comment, expires_at, decided_at,
                  created_at
             from web_approvals where id = ?`,
        )
        .get(id);
      return {
        ...(stored as Record<string, unknown>),
        url: `${runtime.config.publicUrl.replace(/\/$/, '')}/freigabe/${tenantId}/${plaintext}`,
      };
    },
  );

  // --- Releases ------------------------------------------------------------

  runtime.app.get<{ Params: { siteId: string } }>(
    '/websites/:siteId/releases',
    {
      preHandler: runtime.app.requireRole('tenant_admin', 'employee', 'operator'),
      schema: { summary: 'Published releases of a website' },
    },
    async (request) => {
      const database = runtime.tenantDatabase(request);
      const site = requireSite(database, request.params.siteId);
      return {
        items: database
          .prepare('select * from web_releases where site_id = ? order by published_at desc')
          .all(site.id),
      };
    },
  );

  runtime.app.post<{ Params: { siteId: string }; Body: { build_id?: string } }>(
    '/websites/:siteId/releases',
    {
      preHandler: runtime.app.requireRole('tenant_admin', 'operator'),
      schema: {
        summary: 'Publish a build after the client approved it',
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['build_id'],
          properties: { build_id: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const database = runtime.tenantDatabase(request);
      const site = requireSite(database, request.params.siteId);
      const build = findBuild(database, site.id, request.body.build_id ?? '');
      if (!build) throw notFound('Build not found.');
      if (build.status !== 'ok') {
        throw invalidState('Only a successful build can be published.');
      }
      const current = runtime.settings(database);
      if (current.require_approval === 1) {
        const approval = database
          .prepare(
            `select id from web_approvals
              where site_id = ? and build_id = ? and state = 'approved' limit 1`,
          )
          .get(site.id, build.id) as { id: string } | undefined;
        if (!approval) {
          throw invalidState('The client has not approved this build yet.');
        }
      }

      const already = database
        .prepare('select id from web_releases where build_id = ? limit 1')
        .get(build.id) as { id: string } | undefined;
      if (already) throw invalidState('This build is already published.');

      const published = database
        .prepare('select count(*) as count from web_releases where site_id = ?')
        .get(site.id) as { count: number };
      const id = newId('rel');
      const timestamp = runtime.now().toISOString();
      database
        .prepare(
          `insert into web_releases (id, site_id, build_id, version, published_by, published_at)
           values (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          site.id,
          build.id,
          `v${published.count + 1}`,
          request.user?.id ?? 'unknown',
          timestamp,
        );
      database
        .prepare("update web_sites set status = 'live', updated_at = ? where id = ?")
        .run(timestamp, site.id);
      reply.code(201);
      return database.prepare('select * from web_releases where id = ?').get(id);
    },
  );

  // --- Settings ------------------------------------------------------------

  runtime.app.get(
    '/websites/settings',
    {
      preHandler: runtime.app.requireRole('tenant_admin', 'operator'),
      schema: { summary: 'AI provider and budget settings of the tenant' },
    },
    async (request) => {
      const database = runtime.tenantDatabase(request);
      const row = runtime.settings(database);
      return {
        ...row,
        require_approval: row.require_approval === 1,
        generate_images: row.generate_images === 1,
      };
    },
  );

  runtime.app.put<{
    Body: {
      provider?: string;
      model?: string;
      max_tokens_per_run?: number;
      max_cost_cents_per_run?: number;
      monthly_budget_cents?: number;
      require_approval?: boolean;
      generate_images?: boolean;
    };
  }>(
    '/websites/settings',
    {
      preHandler: runtime.app.requireRole('tenant_admin', 'operator'),
      schema: {
        summary: 'Update AI provider and budget settings',
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            provider: { type: 'string', enum: ['anthropic', 'openai', 'local'] },
            model: { type: 'string', minLength: 1, maxLength: 80 },
            max_tokens_per_run: { type: 'integer', minimum: 500, maximum: 200_000 },
            max_cost_cents_per_run: { type: 'integer', minimum: 0, maximum: 100_000 },
            monthly_budget_cents: { type: 'integer', minimum: 0, maximum: 1_000_000 },
            require_approval: { type: 'boolean' },
            generate_images: { type: 'boolean' },
          },
        },
      },
    },
    async (request) => {
      const database = runtime.tenantDatabase(request);
      const current = runtime.settings(database);
      const provider = request.body.provider ?? current.provider;
      const model = request.body.model ?? current.model;
      const maxTokens = request.body.max_tokens_per_run ?? current.max_tokens_per_run;
      const maxCost = request.body.max_cost_cents_per_run ?? current.max_cost_cents_per_run;
      const budget = request.body.monthly_budget_cents ?? current.monthly_budget_cents;
      const requireApproval =
        request.body.require_approval === undefined
          ? current.require_approval
          : request.body.require_approval
            ? 1
            : 0;
      const generateImages =
        request.body.generate_images === undefined
          ? current.generate_images
          : request.body.generate_images
            ? 1
            : 0;
      if (maxTokens > 200_000 || maxCost < 0 || budget < 0) {
        throw new FieldError({
          form: 'Check the limits; they must stay within the allowed range.',
        });
      }
      database
        .prepare(
          `update web_settings
              set provider = ?, model = ?, max_tokens_per_run = ?, max_cost_cents_per_run = ?,
                  monthly_budget_cents = ?, require_approval = ?, generate_images = ?,
                  updated_at = ?
            where id = 1`,
        )
        .run(
          provider,
          model,
          maxTokens,
          maxCost,
          budget,
          requireApproval,
          generateImages,
          runtime.now().toISOString(),
        );
      const row = runtime.settings(database);
      return {
        ...row,
        require_approval: row.require_approval === 1,
        generate_images: row.generate_images === 1,
      };
    },
  );

  // --- Public approval view ------------------------------------------------

  /**
   * The token is the only credential here and it lives in one tenant database.
   * Without a session the plugin cannot know which tenant to open, and scanning
   * every tenant is exactly what the kernel forbids — so the link names the
   * tenant. Knowing a random tenant id grants nothing without the token.
   */
  function publicApproval(tenantId: string, plaintext: string) {
    // An unknown tenant and an unknown token must be indistinguishable.
    if (!tenantId.startsWith('ten_') || plaintext.length < 16) {
      throw notFound('Approval not found.');
    }
    let database;
    try {
      database = runtime.tenantDb(tenantId);
    } catch {
      throw notFound('Approval not found.');
    }
    const approval = database
      .prepare('select * from web_approvals where token_hash = ?')
      .get(hashToken(plaintext)) as ApprovalRow | undefined;
    if (!approval) throw notFound('Approval not found.');
    if (approval.state === 'open' && Date.parse(approval.expires_at) < runtime.now().getTime()) {
      database
        .prepare("update web_approvals set state = 'expired', decided_at = ? where id = ?")
        .run(runtime.now().toISOString(), approval.id);
      approval.state = 'expired';
    }
    if (approval.state === 'expired') {
      throw new AppError('approval_expired', 'This approval link has expired.', 410);
    }
    const site = requireSite(database, approval.site_id);
    const build = database
      .prepare('select id, status, created_at from web_builds where id = ?')
      .get(approval.build_id) as Pick<BuildRow, 'id' | 'status' | 'created_at'> | undefined;
    return {
      database,
      approval,
      site,
      build,
      pages: runtime.pageRows(database, site.id).map((page) => ({
        route: page.route,
        title: page.title,
        origin: page.origin,
      })),
    };
  }

  runtime.app.get<{ Params: { tenantId: string; token: string } }>(
    '/public/websites/:tenantId/approvals/:token',
    {
      schema: { summary: 'Public approval page data, without a session' },
      logLevel: 'silent',
    },
    async (request, reply) => {
      publicHeaders(reply);
      publicGuard(request.params.tenantId, request.params.token, request.ip);
      const found = publicApproval(request.params.tenantId, request.params.token);
      return {
        site: {
          name: found.site.name,
          domain: found.site.domain,
          status: found.site.status,
        },
        build: found.build ?? null,
        state: found.approval.state,
        recipient: found.approval.recipient,
        expires_at: found.approval.expires_at,
        pages: found.pages,
        comment: found.approval.comment,
      };
    },
  );

  runtime.app.post<{
    Params: { tenantId: string; token: string };
    Body: { decision?: string; comment?: string };
  }>(
    '/public/websites/:tenantId/approvals/:token/decision',
    {
      logLevel: 'silent',
      schema: {
        summary: 'Client decision on a build: approve or request changes',
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['decision'],
          properties: {
            decision: { type: 'string', enum: ['approve', 'changes'] },
            comment: { type: 'string', maxLength: 2_000 },
          },
        },
      },
    },
    async (request, reply) => {
      publicHeaders(reply);
      publicGuard(request.params.tenantId, request.params.token, request.ip);
      const found = publicApproval(request.params.tenantId, request.params.token);
      if (found.approval.state !== 'open') {
        throw invalidState('This approval was already decided.');
      }
      const state: ApprovalState = request.body.decision === 'approve' ? 'approved' : 'changes';
      const comment = optionalText(request.body.comment, 2_000);
      if (state === 'changes' && comment === null) {
        throw new FieldError({ comment: 'Please describe what should change.' });
      }
      // The state predicate makes a parallel second decision a 409 instead of
      // letting the later request win silently.
      const decided = found.database
        .prepare(
          `update web_approvals set state = ?, comment = ?, decided_at = ?
            where id = ? and state = 'open'`,
        )
        .run(state, comment, runtime.now().toISOString(), found.approval.id);
      if (decided.changes === 0) {
        throw invalidState('This approval was already decided.');
      }
      // A change request returns the draft to the team, but an already live
      // release stays published until a new build is approved.
      if (state === 'changes' && found.site.status !== 'live') {
        found.database
          .prepare("update web_sites set status = 'draft', updated_at = ? where id = ?")
          .run(runtime.now().toISOString(), found.site.id);
      }
      runtime.log.info(
        { siteId: found.site.id, approvalId: found.approval.id, state },
        'website approval decided',
      );
      return { state, decided_at: runtime.now().toISOString() };
    },
  );
}
