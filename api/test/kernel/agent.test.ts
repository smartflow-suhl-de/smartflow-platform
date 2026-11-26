import assert from 'node:assert/strict';
import test from 'node:test';
import type { LlmRequest } from '../../src/shared/contract.ts';
import { createTestApp, type TestApp } from './helpers.ts';

type CompleteHandler = (request: LlmRequest, call: number) => unknown | Promise<unknown>;

interface StubOptions {
  overrides?: Record<string, string>;
  status?: { configured: boolean; model: string | null };
  statusCode?: number;
  complete?: CompleteHandler;
  failWithStatus?: number;
  delayMs?: number;
  logStream?: { write(line: string): void };
}

interface StubApp extends TestApp {
  providerCalls: LlmRequest[];
}

/**
 * Builds the app and a provider plugin stand-in in one process.
 *
 * The stub is a real internal route guarded by the kernel's `requireInternal`,
 * so the tests exercise the same token path and JSON contract a provider
 * plugin will. No socket is opened.
 */
async function setup(options: StubOptions = {}): Promise<StubApp> {
  const ctx = await createTestApp(
    {
      SF_AGENT_PROVIDER_BASE: '/api/v1/test-llm',
      SF_AGENT_RATE_PER_MINUTE: '100',
      ...(options.overrides ?? {}),
    },
    options.logStream ? { logStream: options.logStream } : {},
  );

  const providerCalls: LlmRequest[] = [];
  const status = options.status ?? { configured: true, model: 'test-model' };
  const complete: CompleteHandler =
    options.complete ??
    (() => ({ content: 'Antwort aus der Quelle.', toolCalls: [], model: 'test-model' }));

  ctx.app.get(
    '/api/v1/test-llm/status',
    { preHandler: ctx.app.requireInternal },
    async (_request, reply) => {
      if (options.statusCode && options.statusCode !== 200) {
        reply.code(options.statusCode);
        return { error: { code: 'provider_down', message: 'down' } };
      }
      return status;
    },
  );

  ctx.app.post(
    '/api/v1/test-llm/complete',
    { preHandler: ctx.app.requireInternal },
    async (request, reply) => {
      providerCalls.push(request.body as LlmRequest);
      if (options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      if (options.failWithStatus) {
        reply.code(options.failWithStatus);
        return { error: { code: 'provider_failed', message: 'no' } };
      }
      return await complete(request.body as LlmRequest, providerCalls.length);
    },
  );

  return { ...ctx, providerCalls };
}

function ask(ctx: StubApp, cookie: string, question: string) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/agent/ask',
    headers: { cookie },
    payload: { question },
  });
}

function toolMessage(request: LlmRequest): unknown {
  const last = request.messages.at(-1);
  if (!last || last.role !== 'tool') return null;
  try {
    return JSON.parse(last.content) as unknown;
  } catch {
    return last.content;
  }
}

test('agent routes require a session', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.close());

  for (const [method, url] of [
    ['GET', '/api/v1/agent/status'],
    ['GET', '/api/v1/agent/runs'],
    ['POST', '/api/v1/agent/ask'],
  ] as const) {
    const response = await ctx.app.inject({
      method,
      url,
      ...(method === 'POST' ? { payload: { question: 'Wie viele Mandanten?' } } : {}),
    });
    assert.equal(response.statusCode, 401, `${method} ${url}`);
  }
});

test('a tenant admin cannot see or use the agent', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.close());

  ctx.db
    .prepare(
      'insert into users (id, email, name, role, tenant_id, created_at) values (?, ?, ?, ?, ?, ?)',
    )
    .run(
      'usr_agent_admin',
      'agent-admin@example.com',
      'Admin',
      'tenant_admin',
      null,
      new Date().toISOString(),
    );
  const cookie = await ctx.signIn('agent-admin@example.com');

  for (const [method, url] of [
    ['GET', '/api/v1/agent/status'],
    ['GET', '/api/v1/agent/runs'],
  ] as const) {
    const response = await ctx.app.inject({ method, url, headers: { cookie } });
    assert.equal(response.statusCode, 403, `${method} ${url}`);
  }

  const askResponse = await ask(ctx, cookie, 'Wie viele Mandanten?');
  assert.equal(askResponse.statusCode, 403);

  const nav = await ctx.app.inject({ method: 'GET', url: '/api/v1/nav', headers: { cookie } });
  const plugins = (nav.json() as { items: { plugin: string }[] }).items.map((item) => item.plugin);
  assert.ok(!plugins.includes('agent'), 'the agent nav entry is operator-only');
});

test('status lists the live sources and the provider model', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  const response = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/agent/status',
    headers: { cookie },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    configured: boolean;
    model: string | null;
    reachable: boolean;
    retentionDays: number;
    limits: { perMinute: number; perDay: number };
    sources: { id: string }[];
  };
  assert.equal(body.configured, true);
  assert.equal(body.model, 'test-model');
  assert.equal(body.reachable, true);
  assert.equal(body.limits.perMinute, 100);
  const ids = body.sources.map((source) => source.id);
  assert.ok(ids.includes('tenants.summary'));
  assert.ok(ids.includes('tenants.list'));
  assert.ok(ids.includes('platform.events'));
  assert.ok(ids.includes('platform.plugins'));
  assert.ok(ids.includes('agent.sources'));
});

test('an unreachable provider reports configured:false instead of pretending', async (t) => {
  const ctx = await setup({ statusCode: 500 });
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  const response = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/agent/status',
    headers: { cookie },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { configured: boolean; reachable: boolean; model: null };
  assert.equal(body.configured, false);
  assert.equal(body.reachable, false);
  assert.equal(body.model, null);

  const answer = await ask(ctx, cookie, 'Wie viele Mandanten?');
  assert.equal(answer.statusCode, 503);
  assert.equal((answer.json() as { error: { code: string } }).error.code, 'agent_not_configured');
});

test('ask answers through a source call and records the step', async (t) => {
  const ctx = await setup({
    complete: (request, call) => {
      if (call === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'call_1', name: 'tenants__summary', arguments: '{}' }],
          model: 'test-model',
        };
      }
      const result = toolMessage(request) as { total?: number };
      return {
        content: `Es gibt ${result?.total ?? '?'} Mandanten.`,
        toolCalls: [],
        model: 'test-model',
      };
    },
  });
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/tenants',
    headers: { cookie },
    payload: { name: 'Nordwind GmbH' },
  });
  assert.equal(created.statusCode, 201);

  const response = await ask(ctx, cookie, 'Wie viele Mandanten gibt es?');
  assert.equal(response.statusCode, 200, response.payload);
  const body = response.json() as {
    run: { answer: string; status: string; steps: { source: string; status: string }[] };
    sources: { id: string }[];
  };
  assert.equal(body.run.answer, 'Es gibt 1 Mandanten.');
  assert.equal(body.run.status, 'ok');
  assert.equal(body.run.steps.length, 1);
  assert.equal(body.run.steps[0]?.source, 'tenants.summary');
  assert.equal(body.run.steps[0]?.status, 'ok');
  assert.deepEqual(
    body.sources.map((source) => source.id),
    ['tenants.summary'],
  );

  const toolResult = toolMessage(ctx.providerCalls[1] as LlmRequest) as { total: number };
  assert.equal(toolResult.total, 1);
});

test('an unknown tool is refused and never executed', async (t) => {
  const ctx = await setup({
    complete: (_request, call) =>
      call === 1
        ? {
            content: '',
            toolCalls: [{ id: 'call_1', name: 'sql__raw', arguments: '{"q":"select *"}' }],
            model: 'test-model',
          }
        : { content: 'Dazu habe ich keine Quelle.', toolCalls: [], model: 'test-model' },
  });
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  const response = await ask(ctx, cookie, 'Zeig mir alles.');
  assert.equal(response.statusCode, 200);
  const body = response.json() as { run: { steps: unknown[] } };
  assert.equal(body.run.steps.length, 0);

  const result = toolMessage(ctx.providerCalls[1] as LlmRequest) as { ok: boolean; error: string };
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unknown_source');
});

test('arguments outside the schema are refused and recorded as an error step', async (t) => {
  const ctx = await setup({
    complete: (_request, call) =>
      call === 1
        ? {
            content: '',
            toolCalls: [
              { id: 'call_1', name: 'tenants__list', arguments: '{"limit":999,"sql":"x"}' },
            ],
            model: 'test-model',
          }
        : { content: 'Die Abfrage war ungültig.', toolCalls: [], model: 'test-model' },
  });
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  const response = await ask(ctx, cookie, 'Alle Mandanten mit SQL.');
  assert.equal(response.statusCode, 200);
  const body = response.json() as { run: { steps: { status: string; errorCode?: string }[] } };
  assert.equal(body.run.steps.length, 1);
  assert.equal(body.run.steps[0]?.status, 'error');
  assert.equal(body.run.steps[0]?.errorCode, 'invalid_arguments');

  const result = toolMessage(ctx.providerCalls[1] as LlmRequest) as { ok: boolean; error: string };
  assert.equal(result.error, 'invalid_arguments');
});

test('the plugin source lists what is registered', async (t) => {
  const ctx = await setup({
    complete: (_request, call) =>
      call === 1
        ? {
            content: '',
            toolCalls: [{ id: 'call_1', name: 'platform__plugins', arguments: '{}' }],
            model: 'test-model',
          }
        : { content: 'Zwei Plugins sind installiert.', toolCalls: [], model: 'test-model' },
  });
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  const response = await ask(ctx, cookie, 'Welche Plugins laufen?');
  assert.equal(response.statusCode, 200);
  const result = toolMessage(ctx.providerCalls[1] as LlmRequest) as {
    items: { id: string }[];
  };
  assert.deepEqual(result.items.map((item) => item.id).sort(), [
    'agent',
    'automation-discovery',
    'llm-providers',
    'tenants',
  ]);
});

test('a provider failure becomes 502 and leaves an error run', async (t) => {
  const ctx = await setup({ failWithStatus: 500 });
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  const response = await ask(ctx, cookie, 'Wie viele Mandanten?');
  assert.equal(response.statusCode, 502);
  assert.equal(
    (response.json() as { error: { code: string } }).error.code,
    'agent_provider_failed',
  );

  const runs = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/agent/runs',
    headers: { cookie },
  });
  const body = runs.json() as { items: { status: string; errorCode: string | null }[] };
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0]?.status, 'error');
  assert.equal(body.items[0]?.errorCode, 'agent_provider_failed');
});

test('a hanging provider hits the timeout and answers 504', async (t) => {
  const ctx = await setup({
    overrides: { SF_AGENT_TIMEOUT_MS: '1000' },
    delayMs: 1_500,
  });
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  const response = await ask(ctx, cookie, 'Wie viele Mandanten?');
  assert.equal(response.statusCode, 504);
  assert.equal(
    (response.json() as { error: { code: string } }).error.code,
    'agent_provider_timeout',
  );
});

test('questions are rate limited per minute', async (t) => {
  const ctx = await setup({ overrides: { SF_AGENT_RATE_PER_MINUTE: '1' } });
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  const first = await ask(ctx, cookie, 'Erste Frage?');
  assert.equal(first.statusCode, 200);

  const second = await ask(ctx, cookie, 'Zweite Frage?');
  assert.equal(second.statusCode, 429);
  assert.equal((second.json() as { error: { code: string } }).error.code, 'agent_rate_limited');
});

test('the platform event source never exposes the payload', async (t) => {
  const ctx = await setup({
    complete: (_request, call) =>
      call === 1
        ? {
            content: '',
            toolCalls: [{ id: 'call_1', name: 'platform__events', arguments: '{"limit":5}' }],
            model: 'test-model',
          }
        : { content: 'Ein Ereignis.', toolCalls: [], model: 'test-model' },
  });
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/tenants',
    headers: { cookie },
    payload: { name: 'Tannwerk AG' },
  });
  assert.equal(created.statusCode, 201);

  const response = await ask(ctx, cookie, 'Was ist zuletzt passiert?');
  assert.equal(response.statusCode, 200);
  const toolContent = JSON.stringify(toolMessage(ctx.providerCalls[1] as LlmRequest));
  assert.ok(toolContent.includes('tenant.created'));
  assert.ok(!toolContent.includes('payload'));
  assert.ok(!toolContent.includes('Tannwerk AG'), 'the tenant name stays out of the event source');
});

test('the run list paginates and the detail carries the steps', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  for (const question of ['Frage eins?', 'Frage zwei?']) {
    const response = await ask(ctx, cookie, question);
    assert.equal(response.statusCode, 200);
  }

  const firstPage = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/agent/runs?limit=1',
    headers: { cookie },
  });
  assert.equal(firstPage.statusCode, 200);
  const body = firstPage.json() as {
    items: { id: string; question: string }[];
    total: number;
    nextCursor: string | null;
  };
  assert.equal(body.items.length, 1);
  assert.equal(body.total, 2);
  assert.ok(body.nextCursor);

  const detail = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/agent/runs/${body.items[0]?.id}`,
    headers: { cookie },
  });
  assert.equal(detail.statusCode, 200);
  assert.ok(Array.isArray((detail.json() as { steps: unknown[] }).steps));

  const missing = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/agent/runs/run_missing',
    headers: { cookie },
  });
  assert.equal(missing.statusCode, 404);
});

test('a question is validated and never reaches the provider when empty', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  const empty = await ask(ctx, cookie, '   ');
  assert.equal(empty.statusCode, 422);

  const tooLong = await ask(ctx, cookie, 'x'.repeat(1_001));
  assert.equal(tooLong.statusCode, 422);
  assert.equal(ctx.providerCalls.length, 0);
});

test('the question text never appears in the log', async (t) => {
  const lines: string[] = [];
  const ctx = await setup({ logStream: { write: (line: string) => lines.push(line) } });
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  const marker = 'streng-geheime-frage-4711';
  const response = await ask(ctx, cookie, marker);
  assert.equal(response.statusCode, 200);

  const joined = lines.join('\n');
  assert.ok(!joined.includes(marker), 'the question must not be logged');
});
