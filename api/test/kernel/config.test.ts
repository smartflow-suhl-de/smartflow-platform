import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../../src/kernel/config.ts';
import { createTestApp } from './helpers.ts';

/**
 * Production is the one environment where a wrong default is not a papercut:
 * an insecure origin or an insecure session cookie means credentials on the
 * wire. These tests pin the startup guard that refuses to boot instead.
 */
const PROD_HTTPS = {
  NODE_ENV: 'production',
  SF_PUBLIC_URL: 'https://app.example.test',
  SF_SECURE_COOKIES: '1',
};

test('production start fails when SF_PUBLIC_URL is not https, even with the dev flag', () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'production',
        SF_PUBLIC_URL: 'http://app.example.test',
        SF_DEV_MAGIC_LINK: '1',
      }),
    /SF_PUBLIC_URL must start with https:\/\//,
  );
});

test('production start fails when SF_PUBLIC_URL is missing entirely', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', SF_SECURE_COOKIES: '1' }),
    /SF_PUBLIC_URL must start with https:\/\//,
  );
});

test('production start fails when SF_SECURE_COOKIES=0', () => {
  assert.throws(
    () => loadConfig({ ...PROD_HTTPS, SF_SECURE_COOKIES: '0' }),
    /SF_SECURE_COOKIES=0 is not allowed/,
  );
});

test('production with https and secure cookies starts', () => {
  const config = loadConfig(PROD_HTTPS);

  assert.equal(config.env, 'production');
  assert.equal(config.secureCookies, true);
});

test('the magic-link era settings no longer exist', () => {
  const config = loadConfig({
    ...PROD_HTTPS,
    SF_DEV_MAGIC_LINK: '1',
    SF_DEV_AUTO_LOGIN: '1',
    SF_OPERATOR_EMAIL: 'seed@example.test',
    SF_OPERATOR_NAME: 'Seed',
  }) as unknown as Record<string, unknown>;

  assert.equal('devMagicLink' in config, false);
  assert.equal('devAutoLogin' in config, false);
  assert.equal('operator' in config, false);
  assert.equal('magicLinkTtlSeconds' in config, false);
});

test('a production app cannot even be built on an insecure origin', async () => {
  // Without the startup guard this configuration builds an app that hands out
  // session cookies over plain http.
  await assert.rejects(
    createTestApp({
      NODE_ENV: 'production',
      SF_PUBLIC_URL: 'http://app.example.test',
      SF_DEV_MAGIC_LINK: '1',
    }),
    /SF_PUBLIC_URL must start with https:\/\//,
  );
});

test('the removed magic-link routes answer not_found, not a login', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());

  for (const url of ['/api/v1/auth/magic-link', '/api/v1/auth/confirm']) {
    const response = await ctx.app.inject({
      method: 'POST',
      url,
      payload: { email: 'someone@example.test', token: 'irrelevant' },
    });
    assert.equal(response.statusCode, 404, `${url} must be gone`);
    assert.equal((response.json() as { error: { code: string } }).error.code, 'not_found');
  }
});

test('no operator account exists before setup, whatever the environment says', async (t) => {
  const ctx = await createTestApp({ SF_OPERATOR_EMAIL: 'seed@example.test' });
  t.after(() => ctx.close());

  const row = ctx.db.prepare('select count(*) as count from users').get() as { count: number };
  assert.equal(row.count, 0);
  const state = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/setup' });
  assert.deepEqual(state.json(), { required: true });
});

test('development over http does not require https or secure cookies', () => {
  assert.doesNotThrow(() =>
    loadConfig({
      NODE_ENV: 'development',
      SF_PUBLIC_URL: 'http://127.0.0.1:5273',
      SF_SECURE_COOKIES: '0',
    }),
  );
});

test('the test environment is not treated as production', () => {
  assert.doesNotThrow(() => loadConfig({ NODE_ENV: 'test', SF_PUBLIC_URL: 'http://127.0.0.1' }));
});

test('sign-in rate limit defaults to ten per minute and is configurable', () => {
  assert.equal(loadConfig({}).rateLimit.login, 10);
  assert.equal(loadConfig({ SF_RATE_LIMIT_LOGIN: '4' }).rateLimit.login, 4);
});

test('SF_TRUST_PROXY becomes a hop count, not a blanket trust', () => {
  assert.equal(loadConfig({}).trustProxy, 0);
  assert.equal(loadConfig({ SF_TRUST_PROXY: '0' }).trustProxy, 0);
  assert.equal(loadConfig({ SF_TRUST_PROXY: 'false' }).trustProxy, 0);
  assert.equal(loadConfig({ SF_TRUST_PROXY: '1' }).trustProxy, 1);
  assert.equal(loadConfig({ SF_TRUST_PROXY: '2' }).trustProxy, 2);
  // A bare "true" must not become "trust every hop": the rate limit keys on the
  // client address, and a spoofable header would let one client exhaust it for
  // everyone or dodge it entirely.
  assert.equal(loadConfig({ SF_TRUST_PROXY: 'true' }).trustProxy, 1);
});
