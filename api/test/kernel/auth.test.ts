import assert from 'node:assert/strict';
import test from 'node:test';
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

  const setup = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: SETUP,
  });
  assert.equal(setup.statusCode, 201);

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
