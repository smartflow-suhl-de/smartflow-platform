import assert from 'node:assert/strict';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import { createTestApp, type TestApp } from './helpers.ts';

interface ProviderBody {
  name: string;
  baseUrl: string;
  apiKey?: string;
  authStyle?: 'bearer' | 'header' | 'none';
  authHeader?: string | null;
  preset?: string;
  chatPath?: string;
  allowedPlugins?: string[] | null;
  timeoutMs?: number;
  maxRetries?: number;
  extraHeaders?: Record<string, string>;
}

const TEST_KEY = ['sk', 'test', '123456'].join('-');
const SECOND_KEY = ['sk', 'test', 'second2'].join('-');
const SECRET_HEADER = 'x-internal-token';
const JSON_HEADERS = { 'content-type': 'application/json' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

function stubFetch(
  t: { after: (fn: () => void) => void },
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): string[] {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

async function signInAs(
  ctx: TestApp,
  role: 'tenant_admin' | 'employee',
  email: string,
): Promise<string> {
  ctx.db
    .prepare(
      'insert into users (id, email, name, role, tenant_id, created_at) values (?, ?, ?, ?, ?, ?)',
    )
    .run(`usr_${role}`, email, role, role, null, new Date().toISOString());
  return ctx.signIn(email);
}

async function createProvider(
  app: FastifyInstance,
  cookie: string,
  body: ProviderBody,
): Promise<{ id: string; [key: string]: unknown }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/llm/providers',
    headers: { cookie },
    payload: body,
  });
  assert.equal(response.statusCode, 201, response.payload);
  return response.json() as { id: string; [key: string]: unknown };
}

async function createModel(
  app: FastifyInstance,
  cookie: string,
  providerId: string,
  body: Record<string, unknown>,
): Promise<{ id: string; [key: string]: unknown }> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/llm/providers/${providerId}/models`,
    headers: { cookie },
    payload: body,
  });
  assert.equal(response.statusCode, 201, response.payload);
  return response.json() as { id: string; [key: string]: unknown };
}

async function createPurpose(
  app: FastifyInstance,
  cookie: string,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/llm/purposes',
    headers: { cookie },
    payload: body,
  });
  assert.equal(response.statusCode, 201, response.payload);
}

async function seed(
  ctx: TestApp,
  cookie: string,
  options: {
    allowedPlugins?: string[] | null;
    timeoutMs?: number;
    maxRetries?: number;
    capabilities?: Record<string, boolean>;
    withPurpose?: boolean;
  } = {},
): Promise<{ providerId: string; modelId: string }> {
  const provider = await createProvider(ctx.app, cookie, {
    name: 'Internes Gateway',
    baseUrl: 'https://llm.example/v1',
    authStyle: 'bearer',
    apiKey: TEST_KEY,
    allowedPlugins: options.allowedPlugins ?? null,
    timeoutMs: options.timeoutMs ?? 10_000,
    maxRetries: options.maxRetries ?? 1,
  });
  const model = await createModel(ctx.app, cookie, provider.id, {
    modelKey: 'qwen3-32b',
    label: 'Qwen3 32B',
    capabilities: options.capabilities ?? { tools: true, json: true },
    isDefault: true,
  });
  if (options.withPurpose !== false) {
    await createPurpose(ctx.app, cookie, {
      purpose: 'chat.default',
      modelId: model.id,
    });
  }
  return { providerId: provider.id, modelId: model.id };
}

function internal(
  ctx: TestApp,
  payload: Record<string, unknown>,
  caller = 'agent',
): Promise<import('light-my-request').Response> {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/llm/internal/complete',
    headers: {
      [SECRET_HEADER]: ctx.internalToken,
      'x-internal-caller': caller,
    },
    payload,
  });
}

test('the LLM admin routes need an operator session', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());

  const anonymous = await ctx.app.inject({ method: 'GET', url: '/api/v1/llm/providers' });
  assert.equal(anonymous.statusCode, 401);
  assert.equal((anonymous.json() as { error: { code: string } }).error.code, 'unauthorized');

  const admin = await signInAs(ctx, 'tenant_admin', 'tenant-admin@example.com');
  const forbidden = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/llm/providers',
    headers: { cookie: admin },
  });
  assert.equal(forbidden.statusCode, 403);

  const employee = await signInAs(ctx, 'employee', 'employee@example.com');
  const alsoForbidden = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/llm/providers',
    headers: { cookie: employee },
  });
  assert.equal(alsoForbidden.statusCode, 403);
});

test('creating a provider returns no secret but stores a sealed one', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  const created = await createProvider(ctx.app, cookie, {
    name: 'Internes Gateway',
    baseUrl: 'https://llm.example/v1',
    authStyle: 'bearer',
    apiKey: TEST_KEY,
    extraHeaders: { 'X-Organization': 'smartflow' },
  });

  assert.equal(created.keySet, true);
  assert.deepEqual(created.extraHeaderNames, ['X-Organization']);
  assert.equal(JSON.stringify(created).includes(TEST_KEY), false);
  assert.equal(JSON.stringify(created).includes('smartflow'), false);

  const row = ctx.db
    .prepare('select api_key_sealed, extra_headers_sealed from llm_provider where id = ?')
    .get(created.id as string) as { api_key_sealed: string; extra_headers_sealed: string };
  assert.match(row.api_key_sealed, /^v1\./);
  assert.equal(row.api_key_sealed.includes(TEST_KEY), false);
  assert.match(row.extra_headers_sealed, /^v1\./);

  const detail = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/llm/providers/${created.id as string}`,
    headers: { cookie },
  });
  assert.equal(detail.statusCode, 200);
  assert.equal(JSON.stringify(detail.json()).includes(TEST_KEY), false);
});

test('provider input is validated', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  const badUrl = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/llm/providers',
    headers: { cookie },
    payload: { name: 'X', baseUrl: 'ftp://llm.example' },
  });
  assert.equal(badUrl.statusCode, 422);
  assert.ok((badUrl.json() as { error: { fields: Record<string, string> } }).error.fields.baseUrl);

  const plainHttp = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/llm/providers',
    headers: { cookie },
    payload: { name: 'X', baseUrl: 'http://llm.example/v1' },
  });
  assert.equal(plainHttp.statusCode, 422);

  const missingKey = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/llm/providers',
    headers: { cookie },
    payload: { name: 'X', baseUrl: 'https://llm.example/v1', authStyle: 'bearer' },
  });
  assert.equal(missingKey.statusCode, 422);

  const badPurpose = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/llm/purposes',
    headers: { cookie },
    payload: { purpose: 'not a purpose' },
  });
  assert.equal(badPurpose.statusCode, 422);
});

test('providers page with a cursor and a status filter', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  await createProvider(ctx.app, cookie, {
    name: 'Alpha',
    baseUrl: 'https://alpha.example/v1',
    authStyle: 'none',
  });
  await createProvider(ctx.app, cookie, {
    name: 'Beta',
    baseUrl: 'https://beta.example/v1',
    authStyle: 'none',
  });
  const disabled = await createProvider(ctx.app, cookie, {
    name: 'Gamma',
    baseUrl: 'https://gamma.example/v1',
    authStyle: 'none',
  });
  await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/llm/providers/${disabled.id as string}`,
    headers: { cookie },
    payload: { status: 'disabled' },
  });

  const first = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/llm/providers?limit=1',
    headers: { cookie },
  });
  assert.equal(first.statusCode, 200);
  const page = first.json() as { items: unknown[]; total: number; nextCursor: string | null };
  assert.equal(page.items.length, 1);
  assert.equal(page.total, 3);
  assert.ok(page.nextCursor);

  const second = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/llm/providers?limit=1&cursor=${page.nextCursor as string}`,
    headers: { cookie },
  });
  assert.equal(second.statusCode, 200);
  assert.equal((second.json() as { items: unknown[] }).items.length, 1);

  const filtered = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/llm/providers?status=disabled',
    headers: { cookie },
  });
  assert.equal(filtered.statusCode, 200);
  assert.equal((filtered.json() as { total: number }).total, 1);
});

test('the internal route needs the process token and an allowed caller', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const { providerId } = await seed(ctx, cookie, { allowedPlugins: ['email'] });

  const noToken = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/llm/internal/complete',
    payload: { purpose: 'chat.default', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(noToken.statusCode, 401);

  const notAllowed = await internal(
    ctx,
    { purpose: 'chat.default', messages: [{ role: 'user', content: 'hi' }] },
    'agent',
  );
  assert.equal(notAllowed.statusCode, 403);
  assert.equal(
    (notAllowed.json() as { error: { code: string } }).error.code,
    'llm_caller_not_allowed',
  );

  const usage = ctx.db
    .prepare('select count(*) as count from llm_usage where provider_id = ?')
    .get(providerId) as { count: number };
  assert.equal(usage.count, 1);
});

test('a mapped purpose reaches the provider and records token usage', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const { providerId, modelId } = await seed(ctx, cookie);

  const calls = stubFetch(t, () =>
    json({
      choices: [
        {
          message: { role: 'assistant', content: 'Hallo aus dem Gateway.' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    }),
  );

  const response = await internal(ctx, {
    purpose: 'chat.default',
    messages: [{ role: 'user', content: 'Hallo' }],
    maxTokens: 100,
    metadata: { tenantId: 'ten_demo', requestId: 'req_1' },
  });
  assert.equal(response.statusCode, 200, response.payload);
  const body = response.json() as {
    id: string;
    message: { content: string };
    model: { modelKey: string };
    usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  };
  assert.equal(body.message.content, 'Hallo aus dem Gateway.');
  assert.equal(body.model.modelKey, 'qwen3-32b');
  assert.deepEqual(body.usage, { inputTokens: 12, outputTokens: 5, totalTokens: 17 });
  assert.equal(calls.length, 1);
  assert.match(calls[0] ?? '', /\/chat\/completions$/);

  const usage = ctx.db
    .prepare(
      'select provider_id, model_id, status, input_tokens, output_tokens, tenant_id from llm_usage where id = ?',
    )
    .get(body.id) as {
    provider_id: string;
    model_id: string;
    status: string;
    input_tokens: number;
    output_tokens: number;
    tenant_id: string;
  };
  assert.equal(usage.provider_id, providerId);
  assert.equal(usage.model_id, modelId);
  assert.equal(usage.status, 'ok');
  assert.equal(usage.input_tokens, 12);
  assert.equal(usage.tenant_id, 'ten_demo');
});

test('an unmapped purpose is visible in the usage table', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  await seed(ctx, cookie, { withPurpose: false });

  const response = await internal(ctx, {
    purpose: 'vision.describe',
    messages: [{ role: 'user', content: 'describe' }],
  });
  assert.equal(response.statusCode, 409);
  assert.equal((response.json() as { error: { code: string } }).error.code, 'llm_purpose_unmapped');

  const row = ctx.db
    .prepare('select purpose, status, error_code, provider_id from llm_usage')
    .get() as {
    purpose: string;
    status: string;
    error_code: string;
    provider_id: string | null;
  };
  assert.equal(row.purpose, 'vision.describe');
  assert.equal(row.status, 'error');
  assert.equal(row.error_code, 'llm_purpose_unmapped');
  assert.equal(row.provider_id, null);
});

test('a model without tool support refuses tools instead of faking them', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  await seed(ctx, cookie, { capabilities: { tools: false, json: true } });

  const response = await internal(ctx, {
    purpose: 'chat.default',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      {
        type: 'function',
        function: { name: 'lookup', description: 'look up', parameters: { type: 'object' } },
      },
    ],
  });
  assert.equal(response.statusCode, 422);
  assert.equal(
    (response.json() as { error: { code: string } }).error.code,
    'llm_capability_unsupported',
  );
});

test('a provider timeout is a 504 and retries exactly once', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  await seed(ctx, cookie, { maxRetries: 1 });

  const calls = stubFetch(t, () => {
    const error = new Error('timed out');
    error.name = 'TimeoutError';
    throw error;
  });

  const response = await internal(ctx, {
    purpose: 'chat.default',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(response.statusCode, 504);
  assert.equal((response.json() as { error: { code: string } }).error.code, 'llm_provider_timeout');
  assert.equal(calls.length, 2);

  const usage = ctx.db.prepare('select status, error_code from llm_usage').get() as {
    status: string;
    error_code: string;
  };
  assert.equal(usage.status, 'error');
  assert.equal(usage.error_code, 'llm_provider_timeout');
});

test('a provider failure becomes a 502 without leaking the upstream body', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  await seed(ctx, cookie, { maxRetries: 0 });

  stubFetch(t, () => json({ error: { message: 'TOP-SECRET-UPSTREAM-DETAIL' } }, 500));

  const response = await internal(ctx, {
    purpose: 'chat.default',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(response.statusCode, 502);
  const raw = response.payload;
  assert.equal(raw.includes('TOP-SECRET-UPSTREAM-DETAIL'), false);
  assert.equal(
    (response.json() as { error: { code: string; reason: string } }).error.code,
    'llm_provider_error',
  );
});

test('the provider test route reports reachability without saving', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  stubFetch(t, () => json({ data: [{ id: 'qwen3-32b' }, { id: 'qwen3-8b' }] }));

  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/llm/providers/test',
    headers: { cookie },
    payload: {
      name: 'Draft',
      baseUrl: 'https://llm.example/v1',
      authStyle: 'bearer',
      apiKey: TEST_KEY,
    },
  });
  assert.equal(response.statusCode, 200, response.payload);
  const body = response.json() as {
    ok: boolean;
    models: Array<{ modelKey: string }>;
    latencyMs: number;
  };
  assert.equal(body.ok, true);
  assert.deepEqual(
    body.models.map((model) => model.modelKey),
    ['qwen3-32b', 'qwen3-8b'],
  );

  const list = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/llm/providers',
    headers: { cookie },
  });
  assert.equal((list.json() as { total: number }).total, 0);
});

test('a stored provider test records auth failure without echoing the key', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const provider = await createProvider(ctx.app, cookie, {
    name: 'Auth fail',
    baseUrl: 'https://llm.example/v1',
    authStyle: 'bearer',
    apiKey: TEST_KEY,
  });

  stubFetch(t, () => json({ error: 'unauthorized' }, 401));

  const response = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/llm/providers/${provider.id as string}/test`,
    headers: { cookie },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { ok: boolean; code: string };
  assert.equal(body.ok, false);
  assert.equal(body.code, 'llm_provider_auth');
  assert.equal(response.payload.includes(TEST_KEY), false);

  const row = ctx.db
    .prepare('select last_test_status from llm_provider where id = ?')
    .get(provider.id as string) as { last_test_status: string };
  assert.equal(row.last_test_status, 'auth');
});

test('models are unique per provider and stay while a purpose uses them', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const { providerId, modelId } = await seed(ctx, cookie);

  const duplicate = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/llm/providers/${providerId}/models`,
    headers: { cookie },
    payload: { modelKey: 'qwen3-32b' },
  });
  assert.equal(duplicate.statusCode, 409);
  assert.equal((duplicate.json() as { error: { code: string } }).error.code, 'llm_model_exists');

  const deleteModel = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/v1/llm/models/${modelId}`,
    headers: { cookie },
  });
  assert.equal(deleteModel.statusCode, 409);
  assert.equal((deleteModel.json() as { error: { code: string } }).error.code, 'llm_model_in_use');

  const deleteProvider = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/v1/llm/providers/${providerId}`,
    headers: { cookie },
  });
  assert.equal(deleteProvider.statusCode, 409);
});

test('purposes can be created and reassigned', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const { providerId } = await seed(ctx, cookie, { withPurpose: false });
  const fast = await createModel(ctx.app, cookie, providerId, {
    modelKey: 'qwen3-8b',
    label: 'Qwen3 8B',
  });

  await createPurpose(ctx.app, cookie, { purpose: 'chat.default' });
  const list = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/llm/purposes',
    headers: { cookie },
  });
  assert.equal(list.statusCode, 200);
  const items = (list.json() as { items: Array<{ purpose: string; model: unknown }> }).items;
  assert.equal(items[0]?.purpose, 'chat.default');
  assert.equal(items[0]?.model, null);

  const patched = await ctx.app.inject({
    method: 'PATCH',
    url: '/api/v1/llm/purposes/chat.default',
    headers: { cookie },
    payload: { modelId: fast.id },
  });
  assert.equal(patched.statusCode, 200, patched.payload);
  const body = patched.json() as { model: { modelKey: string } | null };
  assert.equal(body.model?.modelKey, 'qwen3-8b');

  const missing = await ctx.app.inject({
    method: 'PATCH',
    url: '/api/v1/llm/purposes/missing.purpose',
    headers: { cookie },
    payload: { modelId: fast.id },
  });
  assert.equal(missing.statusCode, 404);
});

test('usage is paginated, filtered and summarised', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  await seed(ctx, cookie);

  stubFetch(t, () =>
    json({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  );
  for (let index = 0; index < 3; index += 1) {
    const response = await internal(ctx, {
      purpose: 'chat.default',
      messages: [{ role: 'user', content: `hi ${index}` }],
    });
    assert.equal(response.statusCode, 200);
  }

  const page = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/llm/usage?limit=2',
    headers: { cookie },
  });
  assert.equal(page.statusCode, 200);
  const body = page.json() as { items: unknown[]; total: number; nextCursor: string | null };
  assert.equal(body.total, 3);
  assert.equal(body.items.length, 2);
  assert.ok(body.nextCursor);

  const filtered = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/llm/usage?caller=other',
    headers: { cookie },
  });
  assert.equal((filtered.json() as { total: number }).total, 0);

  const summary = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/llm/usage/summary?days=7',
    headers: { cookie },
  });
  assert.equal(summary.statusCode, 200);
  const totals = summary.json() as {
    calls: number;
    ok: number;
    inputTokens: number;
    outputTokens: number;
    byCaller: Array<{ caller: string; calls: number }>;
  };
  assert.equal(totals.calls, 3);
  assert.equal(totals.ok, 3);
  assert.equal(totals.inputTokens, 30);
  assert.equal(totals.outputTokens, 15);
  assert.deepEqual(totals.byCaller, [{ caller: 'agent', calls: 3, tokens: 45, costMicros: 0 }]);
});

test('prompts and credentials never reach the log', async (t) => {
  const lines: string[] = [];
  const ctx = await createTestApp(
    { SF_LOG_LEVEL: 'info' },
    { logStream: { write: (line: string) => lines.push(line) } },
  );
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  await seed(ctx, cookie);

  stubFetch(t, () =>
    json({
      choices: [{ message: { content: 'logged?' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  );

  const response = await internal(ctx, {
    purpose: 'chat.default',
    messages: [{ role: 'user', content: 'PROMPT-MARKER-DO-NOT-LOG' }],
  });
  assert.equal(response.statusCode, 200);

  const log = lines.join('\n');
  assert.equal(log.includes('PROMPT-MARKER-DO-NOT-LOG'), false);
  assert.equal(log.includes(TEST_KEY), false);
});
test('the nav exposes the plugin to operators only', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  const nav = await ctx.app.inject({ method: 'GET', url: '/api/v1/nav', headers: { cookie } });
  assert.equal(nav.statusCode, 200);
  const entry = (
    nav.json() as {
      items: Array<{
        plugin: string;
        path: string;
        group: string;
        roles: string[];
        createLabel: string | null;
      }>;
    }
  ).items.find((item) => item.plugin === 'llm-providers');
  assert.equal(entry?.path, '/llm');
  assert.equal(entry?.group, 'management');
  assert.deepEqual(entry?.roles, ['operator']);
  assert.equal(entry?.createLabel, 'Provider verbinden');

  const adminEmail = ['tenant', 'nav', 'admin'].join('.') + '@' + 'example.com';
  const admin = await signInAs(ctx, 'tenant_admin', adminEmail);
  const adminNav = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/nav',
    headers: { cookie: admin },
  });
  const plugins = (adminNav.json() as { items: Array<{ plugin: string }> }).items.map(
    (item) => item.plugin,
  );
  assert.equal(plugins.includes('llm-providers'), false);
});

test('an unused provider can be deleted', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const provider = await createProvider(ctx.app, cookie, {
    name: 'Wegwerf',
    baseUrl: 'https://llm.example/v1',
    authStyle: 'none',
  });

  const deleted = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/v1/llm/providers/${provider.id as string}`,
    headers: { cookie },
  });
  assert.equal(deleted.statusCode, 204);

  const list = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/llm/providers',
    headers: { cookie },
  });
  assert.equal((list.json() as { total: number }).total, 0);
});

test('rotating a key keeps the old value out of every response', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const provider = await createProvider(ctx.app, cookie, {
    name: 'Rotation',
    baseUrl: 'https://llm.example/v1',
    authStyle: 'bearer',
    apiKey: TEST_KEY,
  });

  const before = (
    ctx.db
      .prepare('select api_key_sealed from llm_provider where id = ?')
      .get(provider.id as string) as { api_key_sealed: string }
  ).api_key_sealed;

  const rotated = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/llm/providers/${provider.id as string}`,
    headers: { cookie },
    payload: { apiKey: SECOND_KEY },
  });
  assert.equal(rotated.statusCode, 200, rotated.payload);
  assert.equal(rotated.payload.includes(SECOND_KEY), false);

  const after = (
    ctx.db
      .prepare('select api_key_sealed from llm_provider where id = ?')
      .get(provider.id as string) as { api_key_sealed: string }
  ).api_key_sealed;
  assert.notEqual(before, after);
  assert.match(after, /^v1\./);
  assert.equal(after.includes(SECOND_KEY), false);
});

test('embeddings use the same purpose and access rules', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const provider = await createProvider(ctx.app, cookie, {
    name: 'Embedding provider',
    baseUrl: 'https://llm.example/v1',
    authStyle: 'bearer',
    apiKey: TEST_KEY,
  });
  const model = await createModel(ctx.app, cookie, provider.id, {
    modelKey: 'bge-m3',
    label: 'BGE-M3',
    capabilities: { embeddings: true },
  });
  await createPurpose(ctx.app, cookie, { purpose: 'embedding', modelId: model.id });

  stubFetch(t, () =>
    json({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
      usage: { prompt_tokens: 3 },
    }),
  );

  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/llm/internal/embed',
    headers: { 'x-internal-token': ctx.internalToken, 'x-internal-caller': 'agent' },
    payload: { purpose: 'embedding', input: ['Hallo Welt'] },
  });
  assert.equal(response.statusCode, 200, response.payload);
  const body = response.json() as {
    vectors: number[][];
    usage: { inputTokens: number };
    model: { modelKey: string };
  };
  assert.deepEqual(body.vectors, [[0.1, 0.2, 0.3]]);
  assert.equal(body.usage.inputTokens, 3);
  assert.equal(body.model.modelKey, 'bge-m3');
});

test('a rate-limited primary falls back to its configured model', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  const primary = await createProvider(ctx.app, cookie, {
    name: 'Primary',
    baseUrl: 'https://primary.example/v1',
    authStyle: 'none',
    maxRetries: 0,
  });
  const primaryModel = await createModel(ctx.app, cookie, primary.id, {
    modelKey: 'primary-model',
    label: 'Primary',
  });
  const fallback = await createProvider(ctx.app, cookie, {
    name: 'Fallback',
    baseUrl: 'https://fallback.example/v1',
    authStyle: 'none',
  });
  const fallbackModel = await createModel(ctx.app, cookie, fallback.id, {
    modelKey: 'fallback-model',
    label: 'Fallback',
  });
  await createPurpose(ctx.app, cookie, {
    purpose: 'chat.default',
    modelId: primaryModel.id,
    fallbackModelId: fallbackModel.id,
  });

  const seen: string[] = [];
  stubFetch(t, (url) => {
    seen.push(url);
    if (url.includes('primary.example')) {
      return json({ error: 'slow down' }, 429);
    }
    return json({
      choices: [{ message: { content: 'from fallback' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
  });

  const response = await internal(ctx, {
    purpose: 'chat.default',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(response.statusCode, 200, response.payload);
  const body = response.json() as { model: { modelKey: string } };
  assert.equal(body.model.modelKey, 'fallback-model');
  assert.equal(seen.length, 2);
  assert.match(seen[0] ?? '', /primary\.example/);
  assert.match(seen[1] ?? '', /fallback\.example/);

  const usage = ctx.db.prepare('select model_id, status from llm_usage').get() as {
    model_id: string;
    status: string;
  };
  assert.equal(usage.model_id, fallbackModel.id);
  assert.equal(usage.status, 'ok');
});
