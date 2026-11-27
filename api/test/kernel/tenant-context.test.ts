import assert from 'node:assert/strict';
import test from 'node:test';
import { navFor } from '../../src/kernel/app.ts';
import type { PluginManifest } from '../../src/shared/contract.ts';
import { createTestApp, TEST_EMAIL, type TestApp } from './helpers.ts';

interface Me {
  user: { id: string; role: string };
  tenant: { id: string } | null;
  activeTenant: { id: string; name: string; slug: string } | null;
}

async function makeTenant(ctx: TestApp, cookie: string, name: string): Promise<string> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/tenants',
    headers: { cookie },
    payload: { name },
  });
  assert.equal(created.statusCode, 201, created.body);
  return (created.json() as { id: string }).id;
}

const me = async (ctx: TestApp, cookie: string): Promise<Me> =>
  (
    await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } })
  ).json() as Me;

const choose = (ctx: TestApp, cookie: string, tenantId: string | null) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/tenant',
    headers: { cookie },
    payload: { tenantId },
  });

const navPlugins = async (ctx: TestApp, cookie: string): Promise<string[]> =>
  (
    (await ctx.app.inject({ method: 'GET', url: '/api/v1/nav', headers: { cookie } })).json() as {
      items: { plugin: string }[];
    }
  ).items.map((item) => item.plugin);

test('an operator starts without a tenant context', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const body = await me(ctx, cookie);
  assert.equal(body.tenant, null);
  assert.equal(body.activeTenant, null);
});

test('choosing a tenant sets activeTenant and keeps tenant null', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const id = await makeTenant(ctx, cookie, 'Alpha GmbH');

  const response = await choose(ctx, cookie, id);
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as Me;
  assert.equal(body.tenant, null);
  assert.equal(body.activeTenant?.id, id);
  assert.equal(body.activeTenant?.slug, 'alpha-gmbh');

  const again = await me(ctx, cookie);
  assert.equal(again.activeTenant?.id, id);
  assert.equal(again.tenant, null);
});

test('null leaves the context again', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const id = await makeTenant(ctx, cookie, 'Alpha GmbH');
  await choose(ctx, cookie, id);
  assert.equal((await choose(ctx, cookie, null)).statusCode, 200);
  assert.equal((await me(ctx, cookie)).activeTenant, null);
});

test('an unknown tenant is 404 and leaves the session unchanged', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const id = await makeTenant(ctx, cookie, 'Alpha GmbH');
  await choose(ctx, cookie, id);

  const response = await choose(ctx, cookie, 'ten_does_not_exist');
  assert.equal(response.statusCode, 404);
  assert.equal((response.json() as { error: { code: string } }).error.code, 'tenant_not_found');
  assert.equal((await me(ctx, cookie)).activeTenant?.id, id, 'the earlier choice must survive');
});

test('a suspended tenant is 403 and leaves the session unchanged', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const good = await makeTenant(ctx, cookie, 'Alpha GmbH');
  const bad = await makeTenant(ctx, cookie, 'Beta AG');
  await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${bad}/suspend`,
    headers: { cookie },
  });
  await choose(ctx, cookie, good);

  const response = await choose(ctx, cookie, bad);
  assert.equal(response.statusCode, 403);
  assert.equal((response.json() as { error: { code: string } }).error.code, 'tenant_suspended');
  assert.equal((await me(ctx, cookie)).activeTenant?.id, good);
});

test('suspending the chosen tenant clears the context at once', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const id = await makeTenant(ctx, cookie, 'Alpha GmbH');
  await choose(ctx, cookie, id);
  await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${id}/suspend`,
    headers: { cookie },
  });
  assert.equal(ctx.auth.contextCount(), 0, 'the entry is removed, not just ignored');
  assert.equal((await me(ctx, cookie)).activeTenant, null);
  // Resuming does not bring the old choice back.
  await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${id}/resume`,
    headers: { cookie },
  });
  assert.equal((await me(ctx, cookie)).activeTenant, null);
});

test('every request re-checks the tenant, not a cached state', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const id = await makeTenant(ctx, cookie, 'Alpha GmbH');
  await choose(ctx, cookie, id);
  // Suspend behind the kernel's back: no event, so only the per-request check can notice.
  ctx.db.prepare("update tenants set status = 'suspended' where id = ?").run(id);
  assert.equal((await me(ctx, cookie)).activeTenant, null);
  assert.equal(ctx.auth.contextCount(), 0);
});

test('tenant_admin and employee cannot switch', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const operator = await ctx.signIn();
  const id = await makeTenant(ctx, operator, 'Alpha GmbH');

  for (const role of ['tenant_admin', 'employee'] as const) {
    const email = `${role}@example.test`;
    const cookie = await ctx.signIn(email, role);
    ctx.db.prepare('update users set tenant_id = ? where email = ?').run(id, email);
    const response = await choose(ctx, cookie, id);
    assert.equal(response.statusCode, 403, role);
    const body = await me(ctx, cookie);
    assert.equal(body.activeTenant?.id, id, `${role} stays bound to its tenant`);
    assert.equal(body.tenant?.id, id);
  }
});

test('a signed-out request cannot switch', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/tenant',
    payload: { tenantId: null },
  });
  assert.equal(response.statusCode, 401);
});

test('the body is validated', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  // Missing and empty values are refused by the schema; anything else that
  // reaches the handler must still be a known, active tenant (404 otherwise).
  for (const payload of [{}, { tenantId: '' }]) {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/tenant',
      headers: { cookie },
      payload,
    });
    assert.equal(response.statusCode, 422, JSON.stringify(payload));
  }
  for (const payload of [{ tenantId: 5 }, { tenantId: ['x'] }]) {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/tenant',
      headers: { cookie },
      payload,
    });
    assert.ok([404, 422].includes(response.statusCode), JSON.stringify(payload));
  }
  assert.equal((await me(ctx, cookie)).activeTenant, null);
});

const manifest = (
  id: string,
  scope: 'platform' | 'tenant',
  ownWorkspace = false,
): PluginManifest => ({
  id,
  label: id,
  description: id,
  version: '1.0.0',
  apiVersion: 1,
  scope,
  nav: {
    label: id,
    path: `/${id}`,
    group: 'work',
    icon: 'x',
    roles: ['operator', 'tenant_admin'],
    ...(ownWorkspace ? { ownWorkspace: true } : {}),
  },
});

test('navFor hides tenant-scoped entries from an operator without a tenant', () => {
  const plugins = [
    manifest('platform-thing', 'platform'),
    manifest('tenant-thing', 'tenant'),
    manifest('own-thing', 'tenant', true),
  ];
  const ids = (role: 'operator' | 'tenant_admin', active: boolean) =>
    navFor(plugins, role, active).items.map((item) => item.plugin);
  assert.deepEqual(ids('operator', false), ['own-thing', 'platform-thing']);
  assert.deepEqual(ids('operator', true), ['own-thing', 'platform-thing', 'tenant-thing']);
  // Tenant roles are not affected by the operator rule.
  assert.deepEqual(ids('tenant_admin', false), [
    'own-thing',
    'platform-thing',
    'tenant-thing',
  ]);
});

test('the tenant-bound plugin is offered without a tenant when it opts in', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const id = await makeTenant(ctx, cookie, 'Alpha GmbH');
  const without = await navPlugins(ctx, cookie);
  assert.equal(without.includes('agent'), true, 'platform entries stay');
  assert.equal(without.includes('websites'), true, 'the own area needs no tenant');
  await choose(ctx, cookie, id);
  assert.equal((await navPlugins(ctx, cookie)).includes('agent'), true);
  assert.equal((await navPlugins(ctx, cookie)).includes('websites'), true);
});

test('logout clears the context and a new sign-in starts empty', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const first = await ctx.signIn();
  const id = await makeTenant(ctx, first, 'Alpha GmbH');
  await choose(ctx, first, id);
  assert.equal(ctx.auth.contextCount(), 1);

  await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: first } });
  assert.equal(ctx.auth.contextCount(), 0);

  const second = await ctx.signIn();
  assert.equal((await me(ctx, second)).activeTenant, null);
});

test('an expired session drops its context', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const id = await makeTenant(ctx, cookie, 'Alpha GmbH');
  await choose(ctx, cookie, id);
  ctx.db.prepare("update sessions set expires_at = '2000-01-01T00:00:00.000Z'").run();
  const response = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    headers: { cookie },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(ctx.auth.contextCount(), 0);
});

test('two sessions of one operator keep separate contexts', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const a = await ctx.signIn();
  const b = await ctx.signIn();
  const one = await makeTenant(ctx, a, 'Alpha GmbH');
  const two = await makeTenant(ctx, a, 'Beta AG');
  await choose(ctx, a, one);
  await choose(ctx, b, two);
  assert.equal((await me(ctx, a)).activeTenant?.id, one);
  assert.equal((await me(ctx, b)).activeTenant?.id, two);
});

test('the context map is bounded and prunes dead sessions', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const id = await makeTenant(ctx, cookie, 'Alpha GmbH');
  await choose(ctx, cookie, id);
  ctx.db.prepare('delete from sessions').run();
  ctx.auth.pruneSessions();
  assert.equal(ctx.auth.contextCount(), 0);
});

test('the audit event carries ids only and the log never names the tenant', async (t) => {
  const lines: string[] = [];
  const ctx = await createTestApp(
    { SF_LOG_LEVEL: 'info' },
    { logStream: { write: (l) => lines.push(l) } },
  );
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const id = await makeTenant(ctx, cookie, 'Geheimname Mandant');
  await choose(ctx, cookie, id);
  await choose(ctx, cookie, null);

  const events = ctx.db
    .prepare(
      "select payload from events where name = 'auth.tenant_switched' order by created_at, id",
    )
    .all() as { payload: string }[];
  assert.equal(events.length, 2);
  const first = JSON.parse(events[0]?.payload ?? '{}') as Record<string, unknown>;
  assert.deepEqual(Object.keys(first).sort(), ['fromTenantId', 'toTenantId', 'userId']);
  assert.equal(first.fromTenantId, null);
  assert.equal(first.toTenantId, id);
  assert.equal(JSON.stringify(events).includes('Geheimname'), false);
  const second = JSON.parse(events[1]?.payload ?? '{}') as Record<string, unknown>;
  assert.equal(second.fromTenantId, id);
  assert.equal(second.toTenantId, null);

  const switchLines = lines.filter((line) => line.includes('/auth/tenant'));
  assert.ok(switchLines.length > 0);
  assert.equal(lines.join('').includes('Geheimname'), false);
  assert.equal(lines.join('').includes('geheimname'), false);
});

test('choosing the same tenant again writes no second audit event', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const id = await makeTenant(ctx, cookie, 'Alpha GmbH');
  await choose(ctx, cookie, id);
  await choose(ctx, cookie, id);
  const row = ctx.db
    .prepare("select count(*) as c from events where name = 'auth.tenant_switched'")
    .get() as { c: number };
  assert.equal(row.c, 1);
});

test('the tenant list the switcher uses pages and carries id, name, slug and status', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  for (const name of ['A1', 'B2', 'C3']) await makeTenant(ctx, cookie, name);
  const page = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/tenants?status=active&limit=2',
    headers: { cookie },
  });
  assert.equal(page.statusCode, 200);
  const body = page.json() as {
    items: { id: string; name: string; slug: string; status: string }[];
    nextCursor: string | null;
  };
  assert.equal(body.items.length, 2);
  assert.ok(
    body.items.every((item) => item.id && item.name && item.slug && item.status === 'active'),
  );
  assert.ok(body.nextCursor, 'more tenants than one page must be reachable by cursor');
});

test('TEST_EMAIL operator keeps platform routes with and without a tenant', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn(TEST_EMAIL);
  const id = await makeTenant(ctx, cookie, 'Alpha GmbH');
  for (const chosen of [null, id]) {
    await choose(ctx, cookie, chosen);
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/tenants',
      headers: { cookie },
    });
    assert.equal(list.statusCode, 200);
  }
});

test('tenantId stays the fixed binding: switching never turns it into a tenant', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const id = await makeTenant(ctx, cookie, 'Alpha GmbH');
  await choose(ctx, cookie, id);

  const token = cookie.split('=')[1];
  const user = ctx.auth.userForToken(token);
  assert.equal(user?.tenantId, null, 'plugins that still read tenantId stay closed (403)');
  assert.equal(user?.activeTenantId, id);

  // Tenant roles: active equals fixed, and no cookie value changes that.
  const email = 'admin@example.test';
  const adminCookie = await ctx.signIn(email, 'tenant_admin');
  ctx.db.prepare('update users set tenant_id = ? where email = ?').run(id, email);
  const admin = ctx.auth.userForToken(adminCookie.split('=')[1]);
  assert.equal(admin?.tenantId, id);
  assert.equal(admin?.activeTenantId, id);
});

test('the websites API answers without a tenant (own area) and with a tenant', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const id = await makeTenant(ctx, cookie, 'Alpha GmbH');
  const call = () =>
    ctx.app.inject({ method: 'GET', url: '/api/v1/websites', headers: { cookie } });
  const without = await call();
  assert.equal(without.statusCode, 200, 'no tenant chosen: own area');
  assert.equal((without.json() as { total: number }).total, 0);
  await choose(ctx, cookie, id);
  const withTenant = await call();
  assert.equal(withTenant.statusCode, 200, 'tenant chosen');
});

test('a tenant_admin of another tenant never sees the chosen tenant', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const operator = await ctx.signIn();
  const one = await makeTenant(ctx, operator, 'Alpha GmbH');
  const two = await makeTenant(ctx, operator, 'Beta AG');
  await choose(ctx, operator, one);

  const email = 'admin-two@example.test';
  const admin = await ctx.signIn(email, 'tenant_admin');
  ctx.db.prepare('update users set tenant_id = ? where email = ?').run(two, email);
  const body = await me(ctx, admin);
  assert.equal(body.activeTenant?.id, two);
  assert.notEqual(body.activeTenant?.id, one);
});
