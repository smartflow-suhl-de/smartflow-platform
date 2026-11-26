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

test('production with https and secure cookies starts and never enables the dev magic link', () => {
  const config = loadConfig({ ...PROD_HTTPS, SF_DEV_MAGIC_LINK: '1' });

  assert.equal(config.env, 'production');
  assert.equal(config.secureCookies, true);
  assert.equal(config.devMagicLink, false);
  assert.equal(config.devAutoLogin, false);
});

test('a production app cannot even be built on an insecure origin', async () => {
  // Without the startup guard this configuration builds an app that hands out
  // a valid login link in the response body for existing accounts.
  await assert.rejects(
    createTestApp({
      NODE_ENV: 'production',
      SF_PUBLIC_URL: 'http://app.example.test',
      SF_DEV_MAGIC_LINK: '1',
    }),
    /SF_PUBLIC_URL must start with https:\/\//,
  );
});

test('production never returns a magic link in the response body', async (t) => {
  const ctx = await createTestApp({
    ...PROD_HTTPS,
    SF_DEV_MAGIC_LINK: '1',
    SF_DEV_AUTO_LOGIN: '1',
  });
  t.after(() => ctx.close());

  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/magic-link',
    payload: { email: ctx.config.operator.email },
  });

  assert.equal(response.statusCode, 202);
  const body = response.json() as {
    sent: boolean;
    expiresAt: string;
    link?: string;
    autoLogin?: boolean;
  };
  assert.equal(body.sent, true);
  assert.ok(body.expiresAt);
  assert.equal(body.link, undefined);
  assert.equal(body.autoLogin, undefined);
  assert.doesNotMatch(response.payload, /token=/);
});

test('development over http still returns the link when the flag is on', () => {
  const config = loadConfig({
    NODE_ENV: 'development',
    SF_PUBLIC_URL: 'http://127.0.0.1:5273',
    SF_DEV_MAGIC_LINK: '1',
  });

  assert.equal(config.devMagicLink, true);
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
