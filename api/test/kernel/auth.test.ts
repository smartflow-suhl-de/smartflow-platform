import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeIp } from '../../src/kernel/routes/auth.ts';
import { buildApp } from '../../src/kernel/app.ts';
import { createTestApp, TEST_EMAIL, TEST_NAME, TEST_PASSWORD } from './helpers.ts';

const SETUP = { email: TEST_EMAIL, name: TEST_NAME, password: TEST_PASSWORD };

test('a fresh installation asks for setup, and setup creates the operator', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());

  const before = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/setup' });
  assert.equal(before.statusCode, 200);
  assert.deepEqual(before.json(), { required: true });

  const setup = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: SETUP,
  });
  assert.equal(setup.statusCode, 201);
  const body = setup.json() as {
    user: { id: string; email: string; name: string; role: string };
    tenant: null;
  };
  assert.equal(body.user.email, TEST_EMAIL);
  assert.equal(body.user.name, TEST_NAME);
  assert.equal(body.user.role, 'operator');
  assert.equal(body.tenant, null);

  // The account stores a hash, never the password, and the response leaks neither.
  const row = ctx.db.prepare('select password_hash from users where email = ?').get(TEST_EMAIL) as {
    password_hash: string;
  };
  assert.match(row.password_hash, /^scrypt\$\d+\$\d+\$\d+\$/);
  assert.equal(
    row.password_hash.includes(TEST_PASSWORD),
    false,
    'the plaintext reached the database',
  );
  assert.equal(setup.payload.includes('scrypt$'), false, 'the hash reached the response');

  const cookie = String(setup.headers['set-cookie']);
  assert.match(cookie, /^sf_session=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.doesNotMatch(cookie, /Secure/i, 'a plain-http origin must not set Secure');

  const me = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    headers: { cookie: cookie.split(';')[0] as string },
  });
  assert.equal(me.statusCode, 200);
  assert.deepEqual(me.json(), {
    user: { id: body.user.id, email: TEST_EMAIL, name: TEST_NAME, role: 'operator' },
    tenant: null,
  });

  const after = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/setup' });
  assert.deepEqual(after.json(), { required: false });
});

test('setup can only run once', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());

  const first = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: SETUP });
  assert.equal(first.statusCode, 201);

  const second = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: { ...SETUP, email: 'second@example.test' },
  });
  assert.equal(second.statusCode, 409);
  assert.equal((second.json() as { error: { code: string } }).error.code, 'setup_complete');

  const count = ctx.db.prepare('select count(*) as count from users').get() as { count: number };
  assert.equal(count.count, 1);
});

test('two parallel setups create exactly one operator', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());

  const responses = await Promise.all([
    ctx.app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: SETUP }),
    ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { ...SETUP, email: 'parallel@example.test' },
    }),
  ]);
  const codes = responses.map((response) => response.statusCode).sort();
  assert.deepEqual(codes, [201, 409]);

  const count = ctx.db.prepare('select count(*) as count from users').get() as { count: number };
  assert.equal(count.count, 1);
});

test('setup rejects a short password and an invalid address', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());

  const shortPassword = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: { ...SETUP, password: 'kurz' },
  });
  assert.equal(shortPassword.statusCode, 422);
  const shortBody = shortPassword.json() as {
    error: { code: string; fields: Record<string, string> };
  };
  assert.equal(shortBody.error.code, 'validation_failed');
  assert.ok(shortBody.error.fields.password);

  const badAddress = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: { ...SETUP, email: 'keine-adresse' },
  });
  assert.equal(badAddress.statusCode, 422);
  assert.ok(
    (badAddress.json() as { error: { fields: Record<string, string> } }).error.fields.email,
  );

  // Neither attempt may have claimed the installation.
  const state = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/setup' });
  assert.deepEqual(state.json(), { required: true });
});

test('setup refuses an address that another account already uses', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());

  ctx.db
    .prepare(
      'insert into users (id, email, name, role, tenant_id, created_at) values (?, ?, ?, ?, ?, ?)',
    )
    .run('usr_staff', TEST_EMAIL, 'Staff', 'tenant_admin', null, new Date().toISOString());

  const setup = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: SETUP });
  assert.equal(setup.statusCode, 422);
  assert.ok((setup.json() as { error: { fields: Record<string, string> } }).error.fields.email);
});

test('setup is recorded in the audit log, and so is the session it opens', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());

  const setup = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: SETUP });
  assert.equal(setup.statusCode, 201);

  const events = ctx.db
    .prepare("select name from events where name like 'auth.%' order by created_at")
    .all() as { name: string }[];
  assert.deepEqual(
    events.map((event) => event.name),
    ['auth.setup_completed', 'auth.signed_in'],
  );
});

test('login needs the right password and does not reveal whether an address exists', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: SETUP });
  const sessionsBefore = ctx.db.prepare('select count(*) as count from sessions').get() as {
    count: number;
  };

  const wrong = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: TEST_EMAIL, password: 'SI_SECRET_PASSWORD_9WM0PL2K' },
  });
  const unknown = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'unbekannt@example.test', password: 'SI_SECRET_PASSWORD_9WM0PL2K' },
  });
  assert.equal(wrong.statusCode, 401);
  assert.equal(unknown.statusCode, 401);
  assert.deepEqual(wrong.json(), unknown.json());
  assert.equal((wrong.json() as { error: { code: string } }).error.code, 'invalid_credentials');

  const sessions = ctx.db.prepare('select count(*) as count from sessions').get() as {
    count: number;
  };
  assert.equal(sessions.count, sessionsBefore.count, 'a failed sign-in must not open a session');

  const ok = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: TEST_EMAIL, password: TEST_PASSWORD },
  });
  assert.equal(ok.statusCode, 200);
  const cookie = String(ok.headers['set-cookie']);
  assert.match(cookie, /^sf_session=/);
  assert.match(cookie, /HttpOnly/i);

  const me = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    headers: { cookie: cookie.split(';')[0] as string },
  });
  assert.equal(me.statusCode, 200);
  assert.equal((me.json() as { user: { email: string } }).user.email, TEST_EMAIL);
});

test('login is impossible before setup', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());

  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: TEST_EMAIL, password: TEST_PASSWORD },
  });
  assert.equal(login.statusCode, 401);
  assert.equal((login.json() as { error: { code: string } }).error.code, 'invalid_credentials');
});

test('the session cookie is Secure on an https origin', async (t) => {
  const ctx = await createTestApp({ SF_PUBLIC_URL: 'https://platform.example.test' });
  t.after(() => ctx.close());

  const setup = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: SETUP });
  assert.equal(setup.statusCode, 201);
  assert.match(String(setup.headers['set-cookie']), /; Secure/i);
});

test('a legacy operator without a password is claimed by the first setup', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());

  // The old seed left exactly this row behind: an operator, no password.
  ctx.db
    .prepare(
      'insert into users (id, email, name, role, tenant_id, created_at) values (?, ?, ?, ?, ?, ?)',
    )
    .run('usr_seed', 'seed@example.test', 'Operator', 'operator', null, new Date().toISOString());

  const now = new Date().toISOString();
  ctx.db
    .prepare(
      'insert into sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at) values (?, ?, ?, ?, ?, ?)',
    )
    .run('ses_old', 'usr_seed', 'old-hash', now, new Date(Date.now() + 1e6).toISOString(), now);

  const setup = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: SETUP,
  });
  assert.equal(setup.statusCode, 201);
  assert.equal(
    ctx.db.prepare("select 1 from sessions where id = 'ses_old'").get(),
    undefined,
    'a session from before the password must not survive the takeover',
  );

  const rows = ctx.db.prepare('select id, email, password_hash from users').all() as {
    id: string;
    email: string;
    password_hash: string | null;
  }[];
  assert.equal(rows.length, 1, 'the legacy row is taken over, not duplicated');
  assert.equal(rows[0]?.id, 'usr_seed');
  assert.equal(rows[0]?.email, TEST_EMAIL);
  assert.ok(rows[0]?.password_hash);

  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: TEST_EMAIL, password: TEST_PASSWORD },
  });
  assert.equal(login.statusCode, 200);
});

test('login is rate limited per sender and per address', async (t) => {
  const ctx = await createTestApp({ SF_RATE_LIMIT_ENABLED: '1', SF_RATE_LIMIT_LOGIN: '2' });
  t.after(() => ctx.close());
  await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: SETUP });

  for (let i = 0; i < 2; i += 1) {
    const attempt = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: TEST_EMAIL, password: 'SI_SECRET_PASSWORD_9WM0PL2K' },
    });
    assert.equal(attempt.statusCode, 401);
  }
  const limited = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: TEST_EMAIL, password: TEST_PASSWORD },
  });
  assert.equal(limited.statusCode, 429);
  assert.equal((limited.json() as { error: { code: string } }).error.code, 'rate_limited');

  // The per-IP limit is 10/min, so 30 attempts from different addresses stay
  // under it but exhaust the per-address bucket of 30 per 15 minutes.
  const perAddress = await createTestApp({
    SF_RATE_LIMIT_ENABLED: '1',
    SF_RATE_LIMIT_LOGIN: '10',
  });
  t.after(() => perAddress.close());
  await perAddress.app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: SETUP });

  let blocked = 0;
  for (let i = 0; i < 31; i += 1) {
    const response = await perAddress.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: TEST_EMAIL, password: 'SI_SECRET_PASSWORD_9WM0PL2K' },
      remoteAddress: `10.0.0.${i + 1}`,
    });
    if (response.statusCode === 429) blocked += 1;
  }
  assert.equal(blocked, 1, 'exactly the request past the per-address budget is rejected');
  assert.equal(perAddress.config.rateLimit.login, 10);
});

test('logout ends the session', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());

  const cookie = await ctx.signIn();
  const logout = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/logout',
    headers: { cookie },
  });
  assert.equal(logout.statusCode, 204);

  const after = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    headers: { cookie },
  });
  assert.equal(after.statusCode, 401);
});

test('a session expires with the configured TTL', async (t) => {
  let clock = new Date('2026-01-01T10:00:00.000Z');
  const ctx = await createTestApp();
  t.after(() => ctx.close());

  // A second app over the same data directory with a controllable clock: the
  // session row has to be read by the same database.
  const { app } = await buildApp({ config: ctx.config, logger: false, now: () => clock });
  t.after(() => app.close());

  await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: SETUP });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: TEST_EMAIL, password: TEST_PASSWORD },
  });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers['set-cookie']).split(';')[0] as string;

  clock = new Date(clock.getTime() + (ctx.config.sessionTtlSeconds + 60) * 1000);
  const expired = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    headers: { cookie },
  });
  assert.equal(expired.statusCode, 401);
});

test('rate limits key IPv6 senders by /64 and cover setup', async (t) => {
  const ctx = await createTestApp({
    SF_RATE_LIMIT_ENABLED: '1',
    SF_RATE_LIMIT_LOGIN: '2',
    SF_TRUST_PROXY: '1',
  });
  t.after(() => ctx.close());

  const codes: number[] = [];
  for (let i = 1; i <= 5; i += 1) {
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-forwarded-for': `2001:db8:abcd:1::${i}` },
      payload: { email: `user${i}@example.test`, password: 'SI_SECRET_PASSWORD_9WM0PL2K' },
    });
    codes.push(r.statusCode);
  }
  assert.deepEqual(codes, [401, 401, 429, 429, 429]);
  const limited = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-forwarded-for': '2001:db8:abcd:1::9' },
    payload: { email: 'user9@example.test', password: 'SI_SECRET_PASSWORD_9WM0PL2K' },
  });
  assert.equal(limited.headers['retry-after'], '60');

  // A different /64 has its own budget.
  const other = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-forwarded-for': '2001:db8:abcd:2::1' },
    payload: { email: 'other@example.test', password: 'SI_SECRET_PASSWORD_9WM0PL2K' },
  });
  assert.equal(other.statusCode, 401);

  // Setup is limited too: a valid body reaches the limiter. Each attempt creates
  // nothing only because the operator already exists, so it answers 409 until 429.
  await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: SETUP });
  const setupCodes: number[] = [];
  let setupRetry: unknown;
  for (let i = 1; i <= 4; i += 1) {
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { 'x-forwarded-for': '2001:db8:ffff:1::1' },
      payload: SETUP,
    });
    setupCodes.push(r.statusCode);
    setupRetry = r.headers['retry-after'];
  }
  assert.deepEqual(setupCodes, [409, 409, 429, 429]);
  assert.equal(setupRetry, '60');
});

test('login Retry-After follows the bucket that tripped', async (t) => {
  // Per-IP budget 2 (60 s) is never reached: ten different addresses, one account.
  const ctx = await createTestApp({ SF_RATE_LIMIT_ENABLED: '1', SF_RATE_LIMIT_LOGIN: '2' });
  t.after(() => ctx.close());
  await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: SETUP });
  const seen: Array<{ code: number; retry: unknown }> = [];
  for (let i = 1; i <= 8; i += 1) {
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: TEST_EMAIL, password: 'SI_SECRET_PASSWORD_9WM0PL2K' },
      remoteAddress: `10.1.0.${i}`,
    });
    seen.push({ code: r.statusCode, retry: r.headers['retry-after'] });
  }
  // Email budget is 2 * 3 = 6 per 15 min; attempts 7 and 8 trip it.
  assert.deepEqual(
    seen.map((x) => x.code),
    [401, 401, 401, 401, 401, 401, 429, 429],
  );
  const retry = Number(seen[6]?.retry);
  assert.ok(retry > 60 && retry <= 900, `Retry-After ${retry} must reflect the 15 min window`);

  // The per-IP bucket still answers with its own, short window.
  const ip = await createTestApp({ SF_RATE_LIMIT_ENABLED: '1', SF_RATE_LIMIT_LOGIN: '1' });
  t.after(() => ip.close());
  await ip.app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: SETUP });
  await ip.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: TEST_EMAIL, password: 'SI_SECRET_PASSWORD_9WM0PL2K' },
  });
  const second = await ip.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: TEST_EMAIL, password: 'SI_SECRET_PASSWORD_9WM0PL2K' },
  });
  assert.equal(second.statusCode, 429);
  assert.ok(Number(second.headers['retry-after']) <= 60);
});

test('normalizeIp unpacks IPv4-mapped IPv6 and cuts IPv6 to /64', () => {
  assert.equal(normalizeIp('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(normalizeIp('203.0.113.7'), '203.0.113.7');
  assert.equal(normalizeIp('2001:db8:abcd:1::5'), '2001:db8:abcd:1::/64');
  assert.equal(normalizeIp('2001:0db8:abcd:0001:ffff:ffff:ffff:ffff'), '2001:db8:abcd:1::/64');
  assert.equal(normalizeIp('::1'), '0:0:0:0::/64');
  assert.equal(normalizeIp('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(normalizeIp('2001:DB8:AbCd:1::5'), '2001:db8:abcd:1::/64');
  assert.equal(normalizeIp('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(normalizeIp('::FFFF:203.0.113.7'), '203.0.113.7');
  assert.equal(normalizeIp('::ffff:7f00:1'), '127.0.0.1');
});
