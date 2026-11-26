import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestApp } from './helpers.ts';

/**
 * Roles are enforced at the kernel boundary, not in the page: a tenant admin
 * signed in with a valid session still cannot see the tenant list or create a
 * tenant. The nav follows the same rule.
 */
test('a tenant admin is authenticated but not allowed to manage tenants', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());

  ctx.db
    .prepare(
      'insert into users (id, email, name, role, tenant_id, created_at) values (?, ?, ?, ?, ?, ?)',
    )
    .run(
      'usr_admin',
      'admin@customer.test',
      'Customer Admin',
      'tenant_admin',
      null,
      new Date().toISOString(),
    );
  const cookie = await ctx.signIn('admin@customer.test');

  const me = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    headers: { cookie },
  });
  assert.equal(me.statusCode, 200);
  assert.equal((me.json() as { user: { role: string } }).user.role, 'tenant_admin');

  for (const [method, url] of [
    ['GET', '/api/v1/tenants'],
    ['GET', '/api/v1/tenants/stats'],
    ['POST', '/api/v1/tenants'],
  ] as const) {
    const response = await ctx.app.inject({
      method,
      url,
      headers: { cookie },
      ...(method === 'POST' ? { payload: { name: 'Fremd GmbH' } } : {}),
    });
    assert.equal(response.statusCode, 403, `${method} ${url} must be forbidden`);
    assert.equal((response.json() as { error: { code: string } }).error.code, 'forbidden');
  }

  const nav = await ctx.app.inject({ method: 'GET', url: '/api/v1/nav', headers: { cookie } });
  const plugins = (nav.json() as { items: { plugin: string }[] }).items.map((item) => item.plugin);
  assert.deepEqual(plugins, [], 'tenants is an operator-only nav entry');
});

test('sign-in and sign-out are recorded in the event log', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());

  const cookie = await ctx.signIn();
  await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/logout',
    headers: { cookie },
  });

  const events = ctx.db
    .prepare("select name, payload from events where name like 'auth.%' order by created_at")
    .all() as { name: string; payload: string }[];
  assert.deepEqual(
    events.map((event) => event.name),
    ['auth.signed_in', 'auth.signed_out'],
  );
  assert.deepEqual(JSON.parse(events[0]?.payload ?? '{}'), {
    userId: (JSON.parse(events[0]?.payload ?? '{}') as { userId: string }).userId,
    role: 'operator',
  });
});
