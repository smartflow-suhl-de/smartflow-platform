import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestApp } from './helpers.ts';

test('magic link flow: request, confirm, /auth/me, logout', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());

  const request = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/magic-link',
    payload: { email: 'operator@example.com' },
  });
  assert.equal(request.statusCode, 202);
  const issued = request.json() as { sent: boolean; expiresAt: string; link?: string };
  assert.equal(issued.sent, true);
  assert.ok(issued.expiresAt);
  assert.ok(issued.link, 'development mode returns the link');

  // /auth/me without a session is a 401, not an empty object.
  const anonymous = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me' });
  assert.equal(anonymous.statusCode, 401);

  const token = new URL(issued.link as string).searchParams.get('token') as string;
  const confirm = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/confirm',
    payload: { token },
  });
  assert.equal(confirm.statusCode, 200);
  const cookie = String(confirm.headers['set-cookie']);
  assert.match(cookie, /^sf_session=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.doesNotMatch(cookie, /Secure/i, 'plain-http origin must not set Secure');

  const me = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    headers: { cookie: cookie.split(';')[0] as string },
  });
  assert.equal(me.statusCode, 200);
  assert.deepEqual(me.json(), {
    user: {
      id: (me.json() as { user: { id: string } }).user.id,
      email: 'operator@example.com',
      name: 'Operator',
      role: 'operator',
    },
    tenant: null,
  });

  const logout = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/logout',
    headers: { cookie: cookie.split(';')[0] as string },
  });
  assert.equal(logout.statusCode, 204);

  const after = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    headers: { cookie: cookie.split(';')[0] as string },
  });
  assert.equal(after.statusCode, 401);
});

test('a magic link works exactly once', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());

  const request = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/magic-link',
    payload: { email: 'operator@example.com' },
  });
  const token = new URL((request.json() as { link: string }).link).searchParams.get('token');

  const first = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/confirm',
    payload: { token },
  });
  assert.equal(first.statusCode, 200);

  const second = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/confirm',
    payload: { token },
  });
  assert.equal(second.statusCode, 401);
  assert.equal((second.json() as { error: { code: string } }).error.code, 'invalid_link');
});

test('an expired magic link is rejected', async (t) => {
  let clock = new Date('2026-01-01T10:00:00.000Z');
  const ctx = await createTestApp();
  t.after(() => ctx.close());

  // Build a second app with a controllable clock over the same data directory:
  // the link table has to see the same rows, so use the same config.
  const { buildApp } = await import('../../src/kernel/app.ts');
  const { app } = await buildApp({ config: ctx.config, logger: false, now: () => clock });
  t.after(() => app.close());

  const request = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/magic-link',
    payload: { email: 'operator@example.com' },
  });
  const token = new URL((request.json() as { link: string }).link).searchParams.get('token');

  clock = new Date(clock.getTime() + 16 * 60 * 1000);
  const confirm = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/confirm',
    payload: { token },
  });
  assert.equal(confirm.statusCode, 401);
  assert.equal((confirm.json() as { error: { code: string } }).error.code, 'invalid_link');
});

test('an unknown address gets the same neutral answer and no link', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());

  const request = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/magic-link',
    payload: { email: 'unbekannt@example.test' },
  });
  assert.equal(request.statusCode, 202);
  const body = request.json() as { sent: boolean; link?: string };
  assert.equal(body.sent, true);
  assert.equal(body.link, undefined);
});

test('an invalid address is a field error in English', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());

  const request = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/magic-link',
    payload: { email: 'keine-adresse' },
  });
  assert.equal(request.statusCode, 422);
  const body = request.json() as {
    error: { code: string; message: string; fields: Record<string, string> };
  };
  assert.equal(body.error.code, 'validation_failed');
  assert.ok(body.error.fields.email);
});

test('the magic link is not returned when the origin is https', async (t) => {
  const ctx = await createTestApp({ SF_PUBLIC_URL: 'https://platform.example.test' });
  t.after(() => ctx.close());

  const request = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/magic-link',
    payload: { email: ctx.config.operator.email },
  });
  const body = request.json() as { link?: string };
  assert.equal(body.link, undefined);
});

test('the magic link limit answers 429 and an English message', async (t) => {
  const ctx = await createTestApp({ SF_RATE_LIMIT_ENABLED: '1', SF_RATE_LIMIT_MAGIC_LINK: '2' });
  t.after(() => ctx.close());

  for (let i = 0; i < 2; i += 1) {
    const ok = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link',
      payload: { email: ctx.config.operator.email },
    });
    assert.equal(ok.statusCode, 202);
  }
  const limited = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/magic-link',
    payload: { email: ctx.config.operator.email },
  });
  assert.equal(limited.statusCode, 429);
  assert.equal((limited.json() as { error: { code: string } }).error.code, 'rate_limited');
});

test('auto-login is an explicit opt-in and never applies over https', async (t) => {
  const off = await createTestApp();
  t.after(() => off.close());
  const plain = await off.app.inject({
    method: 'POST',
    url: '/api/v1/auth/magic-link',
    payload: { email: off.config.operator.email },
  });
  const plainBody = plain.json() as { link?: string; autoLogin?: boolean };
  assert.ok(plainBody.link, 'dev magic link is on');
  assert.equal(plainBody.autoLogin, undefined, 'auto-login is off by default');

  const on = await createTestApp({ SF_DEV_AUTO_LOGIN: '1' });
  t.after(() => on.close());
  const auto = await on.app.inject({
    method: 'POST',
    url: '/api/v1/auth/magic-link',
    payload: { email: on.config.operator.email },
  });
  const autoBody = auto.json() as { link?: string; autoLogin?: boolean };
  assert.equal(autoBody.autoLogin, true);
  assert.ok(autoBody.link);

  // The flag alone must not survive a secure origin: no link, no auto-login.
  const secure = await createTestApp({
    SF_DEV_AUTO_LOGIN: '1',
    SF_PUBLIC_URL: 'https://platform.example.test',
  });
  t.after(() => secure.close());
  const blocked = await secure.app.inject({
    method: 'POST',
    url: '/api/v1/auth/magic-link',
    payload: { email: secure.config.operator.email },
  });
  const blockedBody = blocked.json() as { link?: string; autoLogin?: boolean };
  assert.equal(blockedBody.link, undefined);
  assert.equal(blockedBody.autoLogin, undefined);
});

test('the dev magic link is off in production even when explicitly enabled', async (t) => {
  const ctx = await createTestApp({ NODE_ENV: 'production', SF_DEV_MAGIC_LINK: '1' });
  t.after(() => ctx.close());

  assert.equal(ctx.config.devMagicLink, false);

  const request = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/magic-link',
    payload: { email: ctx.config.operator.email },
  });
  const body = request.json() as { link?: string };
  assert.equal(body.link, undefined, 'production never returns the sign-in link');
});

test('the dev magic link is off on a public binding', async (t) => {
  const ctx = await createTestApp({ SF_HOST: '0.0.0.0' });
  t.after(() => ctx.close());

  assert.equal(ctx.config.devMagicLink, false);

  const request = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/magic-link',
    payload: { email: ctx.config.operator.email },
  });
  assert.equal((request.json() as { link?: string }).link, undefined);
});

test('the magic link is rate limited per address as well', async (t) => {
  const ctx = await createTestApp({ SF_RATE_LIMIT_ENABLED: '1', SF_RATE_LIMIT_MAGIC_LINK: '10' });
  t.after(() => ctx.close());

  // The per-IP limit is 10/min, so 30 requests from different IPs stay under it
  // but hit the per-address bucket of 30 per 15 minutes.
  let limited = 0;
  for (let i = 0; i < 31; i += 1) {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link',
      payload: { email: ctx.config.operator.email },
      remoteAddress: `10.0.0.${i + 1}`,
    });
    if (response.statusCode === 429) limited += 1;
  }
  assert.equal(limited, 1, 'exactly the request past the per-address budget is rejected');
  assert.equal(ctx.config.rateLimit.magicLink, 10);
});

test('nav is empty for an anonymous request and is empty for the operator without plugin nav entries', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());

  const anonymous = await ctx.app.inject({ method: 'GET', url: '/api/v1/nav' });
  assert.equal(anonymous.statusCode, 401);

  const cookie = await ctx.signIn();
  const response = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/nav',
    headers: { cookie },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    items: {
      plugin: string;
      label: string;
      path: string;
      roles: string[];
      createLabel: string | null;
    }[];
  };
  assert.deepEqual(body.items, []);
});
