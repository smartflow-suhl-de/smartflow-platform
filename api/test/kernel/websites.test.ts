import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createTestApp, type TestApp } from './helpers.ts';

/**
 * The plugin keeps the agency's whole portfolio in one tenant database. The
 * tests therefore never trust a route to "know" the tenant: each one is called
 * with a real session for that tenant, and a foreign id has to fail.
 */
interface Session {
  ctx: TestApp;
  tenantId: string;
  admin: string;
  employee: string;
}

async function createTenantUser(
  ctx: TestApp,
  tenantId: string,
  email: string,
  role: 'tenant_admin' | 'employee',
  name: string,
): Promise<void> {
  ctx.db
    .prepare(
      'insert into users (id, email, name, role, tenant_id, created_at) values (?, ?, ?, ?, ?, ?)',
    )
    .run(`usr_${email.split('@')[0]}`, email, name, role, tenantId, new Date().toISOString());
}

async function setup(t: TestContext, label = 'Nordwind'): Promise<Session> {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const operator = await ctx.signIn();
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/tenants',
    headers: { cookie: operator },
    payload: { name: label },
  });
  assert.equal(created.statusCode, 201, created.payload);
  const tenantId = (created.json() as { id: string }).id;

  const adminEmail = `admin-${label.toLowerCase()}@example.test`;
  const employeeEmail = `employee-${label.toLowerCase()}@example.test`;
  await createTenantUser(ctx, tenantId, adminEmail, 'tenant_admin', 'Admin');
  await createTenantUser(ctx, tenantId, employeeEmail, 'employee', 'Employee');

  return {
    ctx,
    tenantId,
    admin: await ctx.signIn(adminEmail),
    employee: await ctx.signIn(employeeEmail),
  };
}

/** A second tenant in the same platform, with its own admin session. */
async function addTenant(existing: Session, label: string): Promise<Session> {
  const operator = await existing.ctx.signIn();
  const created = await existing.ctx.app.inject({
    method: 'POST',
    url: '/api/v1/tenants',
    headers: { cookie: operator },
    payload: { name: label },
  });
  assert.equal(created.statusCode, 201, created.payload);
  const tenantId = (created.json() as { id: string }).id;
  const adminEmail = `admin-${label.toLowerCase()}@example.test`;
  const employeeEmail = `employee-${label.toLowerCase()}@example.test`;
  await createTenantUser(existing.ctx, tenantId, adminEmail, 'tenant_admin', 'Admin');
  await createTenantUser(existing.ctx, tenantId, employeeEmail, 'employee', 'Employee');
  return {
    ctx: existing.ctx,
    tenantId,
    admin: await existing.ctx.signIn(adminEmail),
    employee: await existing.ctx.signIn(employeeEmail),
  };
}

function inject(
  session: Session,
  cookie: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  return session.ctx.app.inject({
    method,
    url,
    headers: { cookie, ...headers },
    // `unknown` keeps the helper usable for every route; the schema is what
    // validates the body, exactly as in production.
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
}

async function createSite(session: Session, cookie: string, name = 'Hotel Zum Anker') {
  const response = await inject(session, cookie, 'POST', '/api/v1/websites', {
    name,
    domain: 'hotel-zum-anker.de',
  });
  assert.equal(response.statusCode, 201, response.payload);
  return response.json() as {
    id: string;
    name: string;
    slug: string;
    status: string;
    client_id: string | null;
    last_build: unknown;
  };
}

function runnerHeaders(session: Session): Record<string, string> {
  return {
    'x-internal-token': session.ctx.internalToken,
    'x-tenant-id': session.tenantId,
  };
}

test('without a session every website route answers 401', async (t) => {
  const session = await setup(t);
  for (const [method, url] of [
    ['GET', '/api/v1/websites'],
    ['POST', '/api/v1/websites'],
    ['GET', '/api/v1/websites/summary'],
    ['GET', '/api/v1/websites/settings'],
    ['GET', '/api/v1/websites/clients'],
  ] as const) {
    const response = await session.ctx.app.inject({
      method,
      url,
      ...(method === 'POST' ? { payload: { name: 'Ohne Sitzung' } } : {}),
    });
    assert.equal(response.statusCode, 401, `${method} ${url}`);
    assert.equal((response.json() as { error: { code: string } }).error.code, 'unauthorized');
  }
});

test('an operator without a tenant is refused, an employee may not publish or configure', async (t) => {
  const session = await setup(t);
  const site = await createSite(session, session.admin);

  const operator = await inject(session, await session.ctx.signIn(), 'GET', '/api/v1/websites');
  assert.equal(operator.statusCode, 403);
  assert.equal((operator.json() as { error: { code: string } }).error.code, 'forbidden');

  const forbidden: Array<['POST' | 'PUT' | 'PATCH', string, unknown]> = [
    ['POST', `/api/v1/websites/${site.id}/releases`, { build_id: 'bld_x' }],
    ['PUT', '/api/v1/websites/settings', { provider: 'openai' }],
  ];
  for (const [method, url, payload] of forbidden) {
    const response = await inject(session, session.employee, method, url, payload);
    assert.equal(response.statusCode, 403, `${method} ${url}`);
  }
});

test('a website is created, listed, filtered and summarised', async (t) => {
  const session = await setup(t);
  const site = await createSite(session, session.admin);
  assert.equal(site.status, 'draft');
  assert.equal(site.slug, 'hotel-zum-anker');

  const client = await inject(session, session.admin, 'POST', '/api/v1/websites/clients', {
    name: 'Stadtmarketing Suhl',
    contact_email: 'kontakt@example.test',
  });
  assert.equal(client.statusCode, 201, client.payload);
  const clientId = (client.json() as { id: string }).id;

  const second = await inject(session, session.admin, 'POST', '/api/v1/websites', {
    name: 'Stadtmarketing Suhl',
    client_id: clientId,
  });
  assert.equal(second.statusCode, 201, second.payload);

  const own = await inject(session, session.admin, 'GET', '/api/v1/websites?owner=own');
  assert.equal(own.statusCode, 200);
  assert.equal((own.json() as { total: number }).total, 1);

  const clientSites = await inject(session, session.admin, 'GET', '/api/v1/websites?owner=client');
  assert.equal((clientSites.json() as { total: number }).total, 1);

  const search = await inject(
    session,
    session.employee,
    'GET',
    '/api/v1/websites?q=stadtmarketing',
  );
  const found = search.json() as { items: { client_name: string | null }[] };
  assert.equal(found.items.length, 1);
  assert.equal(found.items[0]?.client_name, 'Stadtmarketing Suhl');

  const summary = await inject(session, session.employee, 'GET', '/api/v1/websites/summary');
  const counts = summary.json() as { total: number; own: number; client: number; draft: number };
  assert.deepEqual(
    { total: counts.total, own: counts.own, client: counts.client, draft: counts.draft },
    { total: 2, own: 1, client: 1, draft: 2 },
  );

  const detail = await inject(session, session.employee, 'GET', `/api/v1/websites/${site.id}`);
  assert.equal(detail.statusCode, 200);
  const body = detail.json() as { client: unknown; pages_count: number; last_build: unknown };
  assert.equal(body.client, null);
  assert.equal(body.pages_count, 0);
  assert.equal(body.last_build, null);
});

test('validation answers 422 with the field that failed', async (t) => {
  const session = await setup(t);

  const empty = await inject(session, session.admin, 'POST', '/api/v1/websites', { name: 'A' });
  assert.equal(empty.statusCode, 422);
  const fields = (empty.json() as { error: { fields: Record<string, string> } }).error.fields;
  assert.ok(fields.name);

  const domain = await inject(session, session.admin, 'POST', '/api/v1/websites', {
    name: 'Gute Seite',
    domain: 'https://example.de/pfad',
  });
  assert.equal(domain.statusCode, 422);
  assert.ok((domain.json() as { error: { fields: Record<string, string> } }).error.fields.domain);

  const badRoute = await inject(session, session.admin, 'POST', '/api/v1/websites', {
    name: 'Zweite Seite',
  });
  const siteId = (badRoute.json() as { id: string }).id;
  const page = await inject(session, session.admin, 'POST', `/api/v1/websites/${siteId}/pages`, {
    route: '../etc/passwd',
    title: 'Böse',
  });
  assert.equal(page.statusCode, 422);
  assert.ok((page.json() as { error: { fields: Record<string, string> } }).error.fields.route);
});

test('a website of another tenant does not exist here', async (t) => {
  const north = await setup(t, 'Nordwind');
  const south = await addTenant(north, 'Suedwind');
  const site = await createSite(north, north.admin);

  const response = await inject(south, south.admin, 'GET', `/api/v1/websites/${site.id}`);
  assert.equal(response.statusCode, 404);
  assert.equal((response.json() as { error: { code: string } }).error.code, 'not_found');

  const deleteIt = await inject(south, south.admin, 'DELETE', `/api/v1/websites/${site.id}`);
  assert.equal(deleteIt.statusCode, 404);
});

test('a suspended tenant keeps its data but loses access', async (t) => {
  const session = await setup(t);
  const site = await createSite(session, session.admin);
  const operator = await session.ctx.signIn();

  await session.ctx.app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${session.tenantId}/suspend`,
    headers: { cookie: operator },
  });

  const blocked = await inject(session, session.admin, 'GET', `/api/v1/websites/${site.id}`);
  assert.equal(blocked.statusCode, 403);
  assert.equal((blocked.json() as { error: { code: string } }).error.code, 'tenant_suspended');

  // Resuming brings the same data back — nothing was deleted by the lockout.
  await session.ctx.app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${session.tenantId}/resume`,
    headers: { cookie: operator },
  });
  const again = await inject(session, session.admin, 'GET', `/api/v1/websites/${site.id}`);
  assert.equal(again.statusCode, 200);
  assert.equal((again.json() as { name: string }).name, site.name);
});

test('the list paginates with a stable keyset cursor', async (t) => {
  const session = await setup(t);
  for (const name of ['Alpha', 'Beta', 'Gamma']) {
    await createSite(session, session.admin, name);
  }

  const first = await inject(session, session.admin, 'GET', '/api/v1/websites?limit=2');
  const pageOne = first.json() as {
    items: Array<{ name: string }>;
    total: number;
    nextCursor: string | null;
  };
  assert.equal(pageOne.items.length, 2);
  assert.equal(pageOne.total, 3);
  assert.ok(pageOne.nextCursor);

  const second = await inject(
    session,
    session.admin,
    'GET',
    `/api/v1/websites?limit=2&cursor=${encodeURIComponent(pageOne.nextCursor ?? '')}`,
  );
  const pageTwo = second.json() as { items: Array<{ name: string }>; nextCursor: string | null };
  assert.equal(pageTwo.items.length, 1);
  assert.equal(pageTwo.nextCursor, null);
  const names = [...pageOne.items, ...pageTwo.items].map((item) => item.name);
  assert.deepEqual(names.sort(), ['Alpha', 'Beta', 'Gamma']);

  const broken = await inject(session, session.admin, 'GET', '/api/v1/websites?cursor=nope');
  assert.equal(broken.statusCode, 400);
});

test('a build must be finished and approved before it can go live', async (t) => {
  const session = await setup(t);
  const site = await createSite(session, session.admin);

  const build = await inject(session, session.admin, 'POST', `/api/v1/websites/${site.id}/builds`, {
    trigger: 'ai',
  });
  assert.equal(build.statusCode, 202, build.payload);
  const buildId = (build.json() as { id: string }).id;

  const secondBuild = await inject(
    session,
    session.admin,
    'POST',
    `/api/v1/websites/${site.id}/builds`,
    {},
  );
  assert.equal(secondBuild.statusCode, 409, 'one active build per website');

  const earlyRelease = await inject(
    session,
    session.admin,
    'POST',
    `/api/v1/websites/${site.id}/releases`,
    { build_id: buildId },
  );
  assert.equal(earlyRelease.statusCode, 409);

  const built = await inject(
    session,
    session.admin,
    'POST',
    `/api/v1/websites/${site.id}/builds/${buildId}/result`,
    { status: 'ok', log: '✓ 24 Seiten in 8,4 s', duration_ms: 8_400 },
    runnerHeaders(session),
  );
  assert.equal(built.statusCode, 200, built.payload);
  assert.equal((built.json() as { status: string }).status, 'ok');

  const approval = await inject(
    session,
    session.admin,
    'POST',
    `/api/v1/websites/${site.id}/approvals`,
    { build_id: buildId, recipient: 'frau-anker@example.test' },
  );
  assert.equal(approval.statusCode, 201, approval.payload);
  const link = approval.json() as { url: string; state: string };
  assert.equal(link.state, 'open');
  const token = link.url.split('/').pop();
  assert.ok(token && token.length > 20);

  const beforeApproval = await inject(
    session,
    session.admin,
    'POST',
    `/api/v1/websites/${site.id}/releases`,
    { build_id: buildId },
  );
  assert.equal(beforeApproval.statusCode, 409, 'publishing waits for the client');

  const publicView = await session.ctx.app.inject({
    method: 'GET',
    url: `/api/v1/public/websites/${session.tenantId}/approvals/${token}`,
  });
  assert.equal(publicView.statusCode, 200, publicView.payload);
  const view = publicView.json() as { site: { name: string }; state: string; pages: unknown[] };
  assert.equal(view.site.name, 'Hotel Zum Anker');
  assert.equal(view.state, 'open');
  assert.ok(Array.isArray(view.pages));

  const decision = await session.ctx.app.inject({
    method: 'POST',
    url: `/api/v1/public/websites/${session.tenantId}/approvals/${token}/decision`,
    payload: { decision: 'approve', comment: 'Sieht gut aus.' },
  });
  assert.equal(decision.statusCode, 200, decision.payload);
  assert.equal((decision.json() as { state: string }).state, 'approved');

  const twice = await session.ctx.app.inject({
    method: 'POST',
    url: `/api/v1/public/websites/${session.tenantId}/approvals/${token}/decision`,
    payload: { decision: 'approve' },
  });
  assert.equal(twice.statusCode, 409, 'an approval is decided once');

  const release = await inject(
    session,
    session.admin,
    'POST',
    `/api/v1/websites/${site.id}/releases`,
    { build_id: buildId },
  );
  assert.equal(release.statusCode, 201, release.payload);
  assert.equal((release.json() as { version: string }).version, 'v1');

  const detail = await inject(session, session.admin, 'GET', `/api/v1/websites/${site.id}`);
  const body = detail.json() as { status: string; release: { version: string } | null };
  assert.equal(body.status, 'live');
  assert.equal(body.release?.version, 'v1');

  const deletion = await inject(session, session.admin, 'DELETE', `/api/v1/websites/${site.id}`);
  assert.equal(deletion.statusCode, 409, 'a published website is not deleted');
});

test('a changed approval blocks publishing until the client approves again', async (t) => {
  const session = await setup(t);
  const site = await createSite(session, session.admin);

  const build = await inject(
    session,
    session.admin,
    'POST',
    `/api/v1/websites/${site.id}/builds`,
    {},
  );
  const buildId = (build.json() as { id: string }).id;
  await inject(
    session,
    session.admin,
    'POST',
    `/api/v1/websites/${site.id}/builds/${buildId}/result`,
    { status: 'ok' },
    runnerHeaders(session),
  );
  const approval = await inject(
    session,
    session.admin,
    'POST',
    `/api/v1/websites/${site.id}/approvals`,
    { build_id: buildId },
  );
  const token = (approval.json() as { url: string }).url.split('/').pop() as string;

  await session.ctx.app
    .inject({
      method: 'POST',
      url: `/api/v1/public/websites/${session.tenantId}/approvals/${token}/decision`,
      payload: { decision: 'changes' },
    })
    .then((response) => {
      assert.equal(response.statusCode, 422, 'a change request needs a comment');
    });

  const changes = await session.ctx.app.inject({
    method: 'POST',
    url: `/api/v1/public/websites/${session.tenantId}/approvals/${token}/decision`,
    payload: { decision: 'changes', comment: 'Bitte das Bild vom Marktplatz.' },
  });
  assert.equal(changes.statusCode, 200, changes.payload);

  const release = await inject(
    session,
    session.admin,
    'POST',
    `/api/v1/websites/${site.id}/releases`,
    { build_id: buildId },
  );
  assert.equal(release.statusCode, 409);
});

test('an expired approval link answers 410 and cannot be decided', async (t) => {
  const session = await setup(t);
  const site = await createSite(session, session.admin);

  const build = await inject(
    session,
    session.admin,
    'POST',
    `/api/v1/websites/${site.id}/builds`,
    {},
  );
  const buildId = (build.json() as { id: string }).id;
  await inject(
    session,
    session.admin,
    'POST',
    `/api/v1/websites/${site.id}/builds/${buildId}/result`,
    { status: 'ok' },
    runnerHeaders(session),
  );
  const approval = await inject(
    session,
    session.admin,
    'POST',
    `/api/v1/websites/${site.id}/approvals`,
    { build_id: buildId, expires_in_days: 1 },
  );
  const token = (approval.json() as { url: string }).url.split('/').pop() as string;

  const database = session.ctx.tenantDb(session.tenantId);
  database
    .prepare('update web_approvals set expires_at = ? where token_hash is not null')
    .run('2000-01-01T00:00:00.000Z');

  const expired = await session.ctx.app.inject({
    method: 'GET',
    url: `/api/v1/public/websites/${session.tenantId}/approvals/${token}`,
  });
  assert.equal(expired.statusCode, 410);
  assert.equal((expired.json() as { error: { code: string } }).error.code, 'approval_expired');
});

test('an AI job writes its pages once and keeps the brief', async (t) => {
  const session = await setup(t);
  const site = await createSite(session, session.admin);

  const job = await inject(session, session.admin, 'POST', `/api/v1/websites/${site.id}/jobs`, {
    goal: 'Übernachtungen und Restaurant direkt buchbar machen.',
    tone: 'ruhig, persönlich',
    pages: ['/zimmer', '/restaurant'],
  });
  assert.equal(job.statusCode, 202, job.payload);
  const jobId = (job.json() as { id: string }).id;

  const running = await inject(
    session,
    session.admin,
    'POST',
    `/api/v1/websites/${site.id}/jobs/${jobId}/result`,
    {
      status: 'ok',
      plan: {
        summary: 'Sechs Seiten, ruhige Typografie.',
        pages: [
          { route: '/', title: 'Startseite' },
          { route: '/zimmer', title: 'Zimmer & Preise' },
        ],
      },
      tokens_in: 12_000,
      tokens_out: 6_400,
      cost_cents: 41,
    },
    runnerHeaders(session),
  );
  assert.equal(running.statusCode, 200, running.payload);

  const pages = await inject(session, session.admin, 'GET', `/api/v1/websites/${site.id}/pages`);
  const list = pages.json() as { items: Array<{ route: string; origin: string }> };
  assert.deepEqual(
    list.items.map((page) => page.route),
    ['/', '/zimmer'],
  );
  assert.ok(list.items.every((page) => page.origin === 'ai'));

  // A rerun updates the same route instead of duplicating it.
  await inject(
    session,
    session.admin,
    'POST',
    `/api/v1/websites/${site.id}/jobs/${jobId}/result`,
    { status: 'ok', plan: { pages: [{ route: '/zimmer', title: 'Zimmer' }] } },
    runnerHeaders(session),
  ).then((response) => assert.equal(response.statusCode, 409, 'a finished job stays finished'));

  const detail = await inject(
    session,
    session.admin,
    'GET',
    `/api/v1/websites/${site.id}/jobs/${jobId}`,
  );
  const body = detail.json() as {
    status: string;
    plan_json: string;
    tokens_in: number;
    cost_cents: number;
  };
  assert.equal(body.status, 'ok');
  assert.equal(body.tokens_in, 12_000);
  assert.equal(body.cost_cents, 41);
  assert.match(body.plan_json, /Sechs Seiten/);
});

test('the monthly AI budget stops new jobs', async (t) => {
  const session = await setup(t);
  const site = await createSite(session, session.admin);

  const settings = await inject(session, session.admin, 'PUT', '/api/v1/websites/settings', {
    monthly_budget_cents: 100,
    max_cost_cents_per_run: 100,
  });
  assert.equal(settings.statusCode, 200, settings.payload);

  const job = await inject(session, session.admin, 'POST', `/api/v1/websites/${site.id}/jobs`, {
    goal: 'Eine Seite für den Förderverein.',
  });
  const jobId = (job.json() as { id: string }).id;
  await inject(
    session,
    session.admin,
    'POST',
    `/api/v1/websites/${site.id}/jobs/${jobId}/result`,
    { status: 'ok', cost_cents: 120 },
    runnerHeaders(session),
  );

  const blocked = await inject(session, session.admin, 'POST', `/api/v1/websites/${site.id}/jobs`, {
    goal: 'Noch eine Seite.',
  });
  assert.equal(blocked.statusCode, 402);
  assert.equal((blocked.json() as { error: { code: string } }).error.code, 'budget_exhausted');
});

test('a job cannot exceed the per-run token limit of the tenant', async (t) => {
  const session = await setup(t);
  const site = await createSite(session, session.admin);

  const tooLarge = await inject(
    session,
    session.admin,
    'POST',
    `/api/v1/websites/${site.id}/jobs`,
    {
      goal: 'Großer Lauf.',
      max_tokens: 500_000,
    },
  );
  assert.equal(tooLarge.statusCode, 422);
});

test('only a tenant admin deletes a draft website, and deletion removes its children', async (t) => {
  const session = await setup(t);
  const site = await createSite(session, session.admin);

  const employeeDelete = await inject(
    session,
    session.employee,
    'DELETE',
    `/api/v1/websites/${site.id}`,
  );
  assert.equal(employeeDelete.statusCode, 403);

  await inject(session, session.admin, 'POST', `/api/v1/websites/${site.id}/pages`, {
    route: '/kontakt',
    title: 'Kontakt',
  });
  const deleted = await inject(session, session.admin, 'DELETE', `/api/v1/websites/${site.id}`);
  assert.equal(deleted.statusCode, 204);

  const gone = await inject(session, session.admin, 'GET', `/api/v1/websites/${site.id}`);
  assert.equal(gone.statusCode, 404);

  const pages = session.ctx
    .tenantDb(session.tenantId)
    .prepare('select count(*) as count from web_site_pages')
    .get() as { count: number };
  assert.equal(pages.count, 0, 'child rows go with the site');
});

test('public approval links are rate limited per sender', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  let lastStatus = 0;
  for (let index = 0; index < 121; index += 1) {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/public/websites/ten_demo/approvals/${'A'.repeat(43)}`,
      remoteAddress: '203.0.113.9',
    });
    lastStatus = response.statusCode;
  }
  assert.equal(lastStatus, 429);
  assert.equal(
    (
      (
        await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/public/websites/ten_demo/approvals/${'A'.repeat(43)}`,
          remoteAddress: '203.0.113.9',
        })
      ).json() as { error: { code: string } }
    ).error.code,
    'rate_limited',
  );
});

test('public approval answers carry no-store, no-referrer and noindex', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/public/websites/ten_demo/approvals/${'A'.repeat(43)}`,
    remoteAddress: '203.0.113.11',
  });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['x-robots-tag'], 'noindex, nofollow');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
});

test('an unknown tenant and an unknown token answer the same 404', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const unknownTenant = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/public/websites/ten_missing/approvals/${'A'.repeat(43)}`,
    remoteAddress: '203.0.113.12',
  });
  const unknownToken = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/public/websites/ten_demo/approvals/${'B'.repeat(43)}`,
    remoteAddress: '203.0.113.13',
  });
  assert.equal(unknownTenant.statusCode, 404);
  assert.equal(unknownToken.statusCode, 404);
  assert.equal(unknownTenant.payload, unknownToken.payload);
});
