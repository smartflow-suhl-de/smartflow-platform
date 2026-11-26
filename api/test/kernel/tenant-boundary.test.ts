import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestApp } from './helpers.ts';

/**
 * The tenant boundary belongs to the kernel: a suspended tenant keeps its data
 * but no code path — plugin or kernel job — opens that database.
 */
test('a suspended tenant database is closed to every caller', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/tenants',
    headers: { cookie },
    payload: { name: 'Southslope' },
  });
  const tenant = created.json() as { id: string };

  // Open once while active, so the connection is cached.
  const open = ctx.tenantDb(tenant.id);
  assert.ok(open.prepare('select count(*) as count from tenant_profile').get());

  await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${tenant.id}/suspend`,
    headers: { cookie },
  });

  assert.throws(
    () => ctx.tenantDb(tenant.id),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      (error as { code: string }).code === 'tenant_suspended',
  );

  // Resuming restores access, and the data written before the suspension is intact.
  await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${tenant.id}/resume`,
    headers: { cookie },
  });
  const resumed = ctx.tenantDb(tenant.id);
  const row = resumed
    .prepare('select display_name from tenant_profile where id = ?')
    .get(tenant.id) as { display_name: string } | undefined;
  assert.equal(row?.display_name, 'Southslope');

  assert.throws(
    () => ctx.tenantDb('ten_missing'),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      (error as { code: string }).code === 'tenant_not_found',
  );
});

test('a suspension closes the cached tenant database', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());

  const cookie = await ctx.signIn();
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/tenants',
    headers: { cookie },
    payload: { name: 'Cache Test' },
  });
  const tenant = created.json() as { id: string };

  const handle = ctx.tenantDb(tenant.id);
  assert.ok(handle.open, 'the handle is open while the tenant is active');

  await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${tenant.id}/suspend`,
    headers: { cookie },
  });

  assert.equal(handle.open, false, 'the kernel closed the cached handle on suspension');

  assert.throws(
    () => ctx.tenantDb(tenant.id),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'tenant_suspended');
      return true;
    },
  );
});
