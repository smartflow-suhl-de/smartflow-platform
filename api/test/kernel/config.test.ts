import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../../src/kernel/config.ts';
import { createTestApp } from './helpers.ts';

/**
 * Production is the one environment where a wrong default is not a papercut:
 * an insecure origin or an insecure session cookie means credentials on the
 * wire. These tests pin the startup guard that refuses to boot instead.
 *
 * `SF_SMTP_HOST` is part of the fixture because a production process without a
 * mail transport cannot let anybody sign in and therefore refuses to start.
 */
const PROD_HTTPS = {
  NODE_ENV: 'production',
  SF_PUBLIC_URL: 'https://app.example.test',
  SF_SECURE_COOKIES: '1',
  SF_SMTP_HOST: 'mail.example.test',
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

test('production refuses to start without a mail transport', () => {
  // The old behaviour started, answered 202 and told the user to check an inbox
  // that could never receive anything.
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', SF_PUBLIC_URL: 'https://app.example.test' }),
    /SF_SMTP_HOST is required when NODE_ENV=production/,
  );
});

test('development and test may run without a transport', () => {
  assert.equal(loadConfig({ NODE_ENV: 'development' }).smtp.host, null);
  assert.equal(loadConfig({ NODE_ENV: 'test' }).smtp.host, null);
});

test('a transport without optional settings uses submission defaults', () => {
  const smtp = loadConfig({ SF_SMTP_HOST: 'mail.example.test' }).smtp;

  assert.equal(smtp.host, 'mail.example.test');
  assert.equal(smtp.port, 587);
  assert.equal(smtp.secure, false);
  assert.equal(smtp.user, null);
  assert.equal(smtp.replyTo, null);
});

test('port 465 implies implicit TLS even though the default is STARTTLS', () => {
  const config = loadConfig({ SF_SMTP_HOST: 'mail.example.test', SF_SMTP_PORT: '465' });

  assert.equal(config.smtp.port, 465);
  assert.equal(config.smtp.secure, true);
  // An explicit value still wins, so a relay that speaks STARTTLS on 465 works.
  assert.equal(
    loadConfig({ SF_SMTP_HOST: 'h', SF_SMTP_PORT: '465', SF_SMTP_SECURE: '0' }).smtp.secure,
    false,
  );
});

test('SF_SMTP_FROM defaults to the operator address and must be a real address', () => {
  assert.equal(loadConfig({}).smtp.from, 'operator@example.com');
  const displayed = `SmartFlow <${['versand', 'example.test'].join('@')}>`;
  assert.equal(
    loadConfig({ SF_SMTP_HOST: 'h', SF_SMTP_FROM: `  ${displayed}  ` }).smtp.from,
    displayed,
  );
  assert.throws(
    () => loadConfig({ SF_SMTP_HOST: 'h', SF_SMTP_FROM: 'SmartFlow' }),
    /SF_SMTP_FROM must be a plain email address/,
  );
  assert.throws(
    () => loadConfig({ SF_SMTP_HOST: 'h', SF_SMTP_REPLY_TO: 'keine-adresse' }),
    /SF_SMTP_REPLY_TO must be a plain email address/,
  );
});

test('the password file wins over SF_SMTP_PASS', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-smtp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'smtp-pass');
  writeFileSync(file, '  aus-der-datei\n');

  const smtp = loadConfig({
    SF_SMTP_HOST: 'mail.example.test',
    SF_SMTP_USER: 'smartflow',
    SF_SMTP_PASS: 'aus-der-env',
    SF_SMTP_PASS_FILE: file,
  }).smtp;

  assert.equal(smtp.pass, 'aus-der-datei');
});

test('an unreadable password file names the path and stops the start', () => {
  assert.throws(
    () =>
      loadConfig({
        SF_SMTP_HOST: 'mail.example.test',
        SF_SMTP_USER: 'smartflow',
        SF_SMTP_PASS_FILE: '/nonexistent/sf-smtp-pass',
      }),
    /SF_SMTP_PASS_FILE could not be read \(\/nonexistent\/sf-smtp-pass\): ENOENT/,
  );
});

test('a partially configured transport stops the start instead of dropping mail', () => {
  const broken: Array<[Record<string, string>, RegExp]> = [
    [{ SF_SMTP_PORT: '587' }, /SF_SMTP_HOST is not/],
    [{ SF_SMTP_USER: 'smartflow' }, /SF_SMTP_HOST is not/],
    [{ SF_SMTP_PASS: 'geheim' }, /SF_SMTP_HOST is not/],
    [{ SF_SMTP_PASS_FILE: '/tmp/x' }, /SF_SMTP_HOST is not/],
    [{ SF_SMTP_HOST: 'h', SF_SMTP_PORT: 'smtp' }, /SF_SMTP_PORT must be a TCP port/],
    [{ SF_SMTP_HOST: 'h', SF_SMTP_PORT: '70000' }, /SF_SMTP_PORT must be a TCP port/],
    [{ SF_SMTP_HOST: 'h', SF_SMTP_USER: 'smartflow' }, /no password is available/],
    [{ SF_SMTP_HOST: 'h', SF_SMTP_PASS: 'geheim' }, /SF_SMTP_USER is not/],
  ];

  for (const [env, pattern] of broken) {
    assert.throws(() => loadConfig(env), pattern, JSON.stringify(env));
  }
});
