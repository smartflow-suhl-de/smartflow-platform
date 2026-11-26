import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createTestApp } from './helpers.ts';

// The expected version comes from package.json, not from a literal: a version
// bump must not turn the gate red. `src/shared/version.ts` carries the same
// value and is the one the health route reports.
const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

test('health reports the running version without a session', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());

  const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/health' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok', version, port: 8790 });
});

test('an unknown route answers the shared error shape, not HTML', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());

  const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/nope' });
  assert.equal(response.statusCode, 404);
  const body = response.json() as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'not_found');
  assert.ok(body.error.message.length > 0);
});

test('the OpenAPI document needs a session', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());

  const anonymous = await ctx.app.inject({ method: 'GET', url: '/api/openapi.json' });
  assert.equal(anonymous.statusCode, 401);
});

test('the OpenAPI document is generated from the routes', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());

  const cookie = await ctx.signIn();
  const response = await ctx.app.inject({
    method: 'GET',
    url: '/api/openapi.json',
    headers: { cookie },
  });
  assert.equal(response.statusCode, 200);
  const doc = response.json() as {
    openapi: string;
    info: { title: string };
    paths: Record<string, Record<string, { summary?: string; tags?: string[] }>>;
  };
  assert.match(doc.openapi, /^3\.1\./);
  for (const path of [
    '/api/v1/health',
    '/api/v1/auth/magic-link',
    '/api/v1/auth/confirm',
    '/api/v1/auth/me',
    '/api/v1/nav',
    '/api/v1/tenants',
    '/api/v1/tenants/{id}',
    '/api/v1/tenants/{id}/suspend',
    '/api/v1/tenants/{id}/resume',
  ]) {
    assert.ok(doc.paths[path], `${path} is missing from openapi.json`);
  }
  // Every documented operation carries a summary — the API-first rule.
  for (const [path, operations] of Object.entries(doc.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      assert.ok(operation.summary, `${method.toUpperCase()} ${path} has no summary`);
    }
  }
});
