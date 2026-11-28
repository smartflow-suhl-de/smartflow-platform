import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { ListResponse, Tenant } from '../../src/shared/contract.ts';
import { createTestApp } from './helpers.ts';

test('tenant list requires an operator session', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());

  const anonymous = await ctx.app.inject({ method: 'GET', url: '/api/v1/tenants' });
  assert.equal(anonymous.statusCode, 401);
  assert.equal((anonymous.json() as { error: { code: string } }).error.code, 'unauthorized');
});

test('create, list and read a tenant', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/tenants',
    headers: { cookie },
    payload: { name: 'Alphabuild GmbH', slug: 'alphabuild' },
  });
  assert.equal(created.statusCode, 201);
  const tenant = created.json() as Tenant;
  assert.match(tenant.id, /^ten_[a-z0-9]+$/);
  assert.equal(tenant.name, 'Alphabuild GmbH');
  assert.equal(tenant.slug, 'alphabuild');
  assert.equal(tenant.status, 'active');
  assert.ok(!Number.isNaN(Date.parse(tenant.created_at)));

  const list = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/tenants',
    headers: { cookie },
  });
  assert.equal(list.statusCode, 200);
  const body = list.json() as ListResponse<Tenant>;
  assert.equal(body.total, 1);
  assert.equal(body.nextCursor, null);
  assert.deepEqual(body.items, [tenant]);

  const one = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/tenants/${tenant.id}`,
    headers: { cookie },
  });
  assert.equal(one.statusCode, 200);
  assert.deepEqual(one.json(), tenant);
});

test('the slug is derived from the name and stays unique', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  const first = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/tenants',
    headers: { cookie },
    payload: { name: 'Mueller Bakery & Sons' },
  });
  assert.equal(first.statusCode, 201);
  assert.equal((first.json() as Tenant).slug, 'mueller-bakery-sons');

  const duplicate = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/tenants',
    headers: { cookie },
    payload: { name: 'Mueller Bakery & Sons' },
  });
  assert.equal(duplicate.statusCode, 409);
  const body = duplicate.json() as { error: { code: string; fields: Record<string, string> } };
  assert.equal(body.error.code, 'slug_taken');
  assert.ok(body.error.fields.slug);
});

test('a name that yields no valid slug asks for one', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/tenants',
    headers: { cookie },
    payload: { name: '??' },
  });
  assert.equal(response.statusCode, 422);
  const fields = (response.json() as { error: { fields: Record<string, string> } }).error.fields;
  assert.ok(fields.slug, 'the slug error explains what to do');

  const tooShort = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/tenants',
    headers: { cookie },
    payload: { name: 'A' },
  });
  assert.equal(tooShort.statusCode, 422);
  assert.ok((tooShort.json() as { error: { fields: { name?: string } } }).error.fields.name);
});

test('suspend and resume are idempotent and emit one event per change', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/tenants',
    headers: { cookie },
    payload: { name: 'Northlight' },
  });
  const tenant = created.json() as Tenant;

  const suspended = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${tenant.id}/suspend`,
    headers: { cookie },
  });
  assert.equal(suspended.statusCode, 200);
  assert.equal((suspended.json() as Tenant).status, 'suspended');

  const again = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${tenant.id}/suspend`,
    headers: { cookie },
  });
  assert.equal(again.statusCode, 200);
  assert.equal((again.json() as Tenant).status, 'suspended');

  const resumed = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${tenant.id}/resume`,
    headers: { cookie },
  });
  assert.equal(resumed.statusCode, 200);
  assert.equal((resumed.json() as Tenant).status, 'active');

  const events = ctx.db
    // rowid as tiebreaker: two events can share the same millisecond, and
    // without it the order is whatever the index returns.
    .prepare("select name from events where name like 'tenant.%' order by created_at, rowid")
    .all() as { name: string }[];
  assert.deepEqual(
    events.map((event) => event.name),
    ['tenant.created', 'tenant.suspended', 'tenant.resumed'],
  );
});

test('stats count by status', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  for (const name of ['Eins', 'Zwei', 'Drei']) {
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { cookie },
      payload: { name },
    });
  }

  const list = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/tenants',
    headers: { cookie },
  });
  const second = (list.json() as ListResponse<Tenant>).items[1] as Tenant;
  await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${second.id}/suspend`,
    headers: { cookie },
  });

  const stats = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/tenants/stats',
    headers: { cookie },
  });
  assert.equal(stats.statusCode, 200);
  assert.deepEqual(stats.json(), { active: 2, suspended: 1, total: 3 });
});

test('the list paginates with an opaque cursor', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  for (let index = 0; index < 5; index += 1) {
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { cookie },
      payload: { name: `Tenant ${index}` },
    });
  }

  const first = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/tenants?limit=2',
    headers: { cookie },
  });
  const pageOne = first.json() as ListResponse<Tenant>;
  assert.equal(pageOne.items.length, 2);
  assert.equal(pageOne.total, 5);
  assert.ok(pageOne.nextCursor);

  const second = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/tenants?limit=2&cursor=${encodeURIComponent(pageOne.nextCursor as string)}`,
    headers: { cookie },
  });
  const pageTwo = second.json() as ListResponse<Tenant>;
  assert.equal(pageTwo.items.length, 2);
  const ids = new Set([...pageOne.items, ...pageTwo.items].map((tenant) => tenant.id));
  assert.equal(ids.size, 4, 'pages do not overlap');

  const invalid = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/tenants?cursor=nope',
    headers: { cookie },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal((invalid.json() as { error: { code: string } }).error.code, 'invalid_cursor');
});

test('search and status filter narrow the list and the total', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  for (const name of ['Alphabuild', 'Northlight', 'Southslope']) {
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { cookie },
      payload: { name },
    });
  }

  const search = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/tenants?q=north',
    headers: { cookie },
  });
  const result = search.json() as ListResponse<Tenant>;
  assert.equal(result.total, 1);
  assert.equal(result.items[0]?.name, 'Northlight');

  const filter = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/tenants?status=suspended',
    headers: { cookie },
  });
  assert.equal((filter.json() as ListResponse<Tenant>).total, 0);
});

test('every tenant gets its own database file', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  const first = (
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { cookie },
      payload: { name: 'Alpha' },
    })
  ).json() as Tenant;
  const second = (
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { cookie },
      payload: { name: 'Beta' },
    })
  ).json() as Tenant;

  const dir = join(ctx.dataDir, 'tenants');
  assert.ok(existsSync(dir));
  const files = readdirSync(dir).filter((name) => name.endsWith('.sqlite'));
  assert.deepEqual(files.sort(), [`${first.id}.sqlite`, `${second.id}.sqlite`].sort());

  // Tenant-scoped migrations ran: the profile row is there. The kernel never
  // opens a tenant database without a tenant id from the directory.
  const { openDatabase } = await import('../../src/kernel/db.ts');
  const alpha = openDatabase(join(dir, `${first.id}.sqlite`));
  t.after(() => alpha.close());
  const row = alpha
    .prepare('select display_name from tenant_profile where id = ?')
    .get(first.id) as { display_name: string } | undefined;
  assert.equal(row?.display_name, 'Alpha');
});

test('master data is captured on create and updated partially', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/tenants',
    headers: { cookie },
    payload: {
      name: 'Nordwind Logistik GmbH',
      legal_name: 'Nordwind Logistik Gesellschaft mit beschränkter Haftung',
      legal_form: 'GmbH',
      street: 'Hafenstraße 12',
      postal_code: '24103',
      city: 'Kiel',
      country: 'Deutschland',
      contact_name: 'Meike Sörensen',
      contact_role: 'Geschäftsführung',
      contact_email: 'm.soerensen@nordwind.example',
      contact_phone: '+49 431 1234567',
      vat_id: 'DE123456789',
    },
  });
  assert.equal(created.statusCode, 201);
  const tenant = created.json() as Tenant;
  assert.equal(tenant.details.street, 'Hafenstraße 12');
  assert.equal(tenant.details.city, 'Kiel');
  assert.equal(tenant.details.contact_name, 'Meike Sörensen');
  assert.equal(tenant.details.notes, null);

  // A partial update keeps every field it does not mention.
  const patched = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/tenants/${tenant.id}`,
    headers: { cookie },
    payload: { phone: '+49 431 7654321', notes: '  Jahresgespräch im März  ' },
  });
  assert.equal(patched.statusCode, 200);
  const updated = patched.json() as Tenant;
  assert.equal(updated.details.phone, '+49 431 7654321');
  assert.equal(updated.details.notes, 'Jahresgespräch im März');
  assert.equal(updated.details.street, 'Hafenstraße 12');
  assert.equal(updated.details.city, 'Kiel');

  // An empty string clears a field instead of storing whitespace.
  const cleared = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/tenants/${tenant.id}`,
    headers: { cookie },
    payload: { city: '   ' },
  });
  assert.equal((cleared.json() as Tenant).details.city, null);

  // The tenant database mirrors the master data for tenant-scoped plugins.
  const { openDatabase } = await import('../../src/kernel/db.ts');
  const file = join(ctx.dataDir, 'tenants', `${tenant.id}.sqlite`);
  const database = openDatabase(file);
  t.after(() => database.close());
  const profile = database
    .prepare('select street, postal_code, city, phone from tenant_profile where id = ?')
    .get(tenant.id) as {
    street: string | null;
    postal_code: string | null;
    city: string | null;
    phone: string | null;
  };
  assert.equal(profile.street, 'Hafenstraße 12');
  assert.equal(profile.postal_code, '24103');
  assert.equal(profile.city, null);
  assert.equal(profile.phone, '+49 431 7654321');
});

test('tenant name and slug are editable; the slug stays unique', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  const first = (
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { cookie },
      payload: { name: 'Alphabuild GmbH', slug: 'alphabuild' },
    })
  ).json() as Tenant;
  const second = (
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { cookie },
      payload: { name: 'Beta GmbH', slug: 'beta' },
    })
  ).json() as Tenant;

  const patched = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/tenants/${first.id}`,
    headers: { cookie },
    payload: { name: 'Alphabuild Nord GmbH', slug: 'alphabuild-nord' },
  });
  assert.equal(patched.statusCode, 200);
  const updated = patched.json() as Tenant;
  assert.equal(updated.name, 'Alphabuild Nord GmbH');
  assert.equal(updated.slug, 'alphabuild-nord');

  const duplicate = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/tenants/${second.id}`,
    headers: { cookie },
    payload: { slug: 'alphabuild-nord' },
  });
  assert.equal(duplicate.statusCode, 409);
  const conflict = duplicate.json() as {
    error: { code: string; fields: Record<string, string> };
  };
  assert.equal(conflict.error.code, 'slug_taken');
  assert.ok(conflict.error.fields.slug);

  const invalid = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/tenants/${first.id}`,
    headers: { cookie },
    payload: { slug: 'Alpha Nord' },
  });
  assert.equal(invalid.statusCode, 422);
  assert.ok((invalid.json() as { error: { fields: Record<string, string> } }).error.fields.slug);
});

test('master data validation rejects bad email and overlong fields', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  const tenant = (
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { cookie },
      payload: { name: 'Alpha' },
    })
  ).json() as Tenant;

  const bad = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/tenants/${tenant.id}`,
    headers: { cookie },
    payload: { contact_email: 'not-an-email' },
  });
  assert.equal(bad.statusCode, 422);
  const body = bad.json() as { error: { code: string; fields: Record<string, string> } };
  assert.equal(body.error.code, 'validation_failed');
  assert.ok(body.error.fields.contact_email);

  const tooLong = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/tenants/${tenant.id}`,
    headers: { cookie },
    payload: { legal_form: 'x'.repeat(61) },
  });
  assert.equal(tooLong.statusCode, 422);
  assert.ok(
    (tooLong.json() as { error: { fields: Record<string, string> } }).error.fields.legal_form,
  );
});

test('a suspended tenant keeps its profile in sync after the resume', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  const tenant = (
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { cookie },
      payload: { name: 'Südpark Handel', city: 'Altstadt' },
    })
  ).json() as Tenant;

  const suspended = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${tenant.id}/suspend`,
    headers: { cookie },
  });
  assert.equal(suspended.statusCode, 200);

  // The platform row is editable while suspended; the tenant database is not
  // reachable through tenantDb, so the copy can only be written on resume.
  const patched = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/tenants/${tenant.id}`,
    headers: { cookie },
    payload: { city: 'Neustadt' },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal((patched.json() as Tenant).details.city, 'Neustadt');

  const resumed = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${tenant.id}/resume`,
    headers: { cookie },
  });
  assert.equal(resumed.statusCode, 200);

  const { openDatabase } = await import('../../src/kernel/db.ts');
  const database = openDatabase(join(ctx.dataDir, 'tenants', `${tenant.id}.sqlite`));
  t.after(() => database.close());
  const profile = database
    .prepare('select display_name, city from tenant_profile where id = ?')
    .get(tenant.id) as { display_name: string | null; city: string | null };
  assert.equal(profile.display_name, 'Südpark Handel');
  assert.equal(profile.city, 'Neustadt');
});

test('transitions reject unknown tenants with 404', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/tenants/ten_missing/suspend',
    headers: { cookie },
  });
  assert.equal(response.statusCode, 404);
  assert.equal((response.json() as { error: { code: string } }).error.code, 'tenant_not_found');
});
