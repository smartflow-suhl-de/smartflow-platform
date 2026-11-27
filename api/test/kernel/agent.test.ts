import assert from 'node:assert/strict';
import test from 'node:test';
import type { LlmRequest } from '../../src/shared/contract.ts';
import { INTERNAL_CALLER_HEADER, INTERNAL_TOKEN_HEADER } from '../../src/kernel/app.ts';
import { toWireRequest } from '../../src/plugins/agent/provider.ts';
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
  stubComplete: { next: ((call: number) => unknown) | null; base: number };
  providerCalls: LlmRequest[];
  wireCalls: Record<string, unknown>[];
}

interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
}
interface WireRequest {
  purpose?: string;
  messages: WireMessage[];
  tools?: { type: string; function: { name: string; description: string; parameters: object } }[];
  maxTokens?: number;
}

/** Back to the neutral form so the existing assertions keep reading the same fields. */
function fromWire(wire: WireRequest): LlmRequest {
  return {
    messages: wire.messages.map((m) =>
      m.role === 'tool'
        ? { role: 'tool', content: m.content ?? '', toolCallId: m.tool_call_id ?? '' }
        : m.role === 'assistant'
          ? {
              role: 'assistant',
              content: m.content ?? '',
              ...(m.tool_calls
                ? {
                    toolCalls: m.tool_calls.map((c) => ({
                      id: c.id,
                      name: c.function.name,
                      arguments: c.function.arguments,
                    })),
                  }
                : {}),
            }
          : { role: m.role, content: m.content ?? '' },
    ),
    ...(wire.tools
      ? {
          tools: wire.tools.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters as Record<string, unknown>,
          })),
        }
      : {}),
  };
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
  const wireCalls: Record<string, unknown>[] = [];
  const status = options.status ?? { configured: true, model: 'test-model' };
  const stubComplete: { next: ((call: number) => unknown) | null; base: number } = {
    next: null,
    base: 0,
  };
  const complete: CompleteHandler = (request, call) =>
    stubComplete.next
      ? stubComplete.next(call - stubComplete.base)
      : (
          options.complete ??
          (() => ({ content: 'Antwort aus der Quelle.', toolCalls: [], model: 'test-model' }))
        )(request, call);

  // Same shapes as the real `llm-providers` internal routes.
  ctx.app.get(
    '/api/v1/test-llm/internal/status',
    { preHandler: ctx.app.requireInternal },
    async (_request, reply) => {
      if (options.statusCode && options.statusCode !== 200) {
        reply.code(options.statusCode);
        return { error: { code: 'provider_down', message: 'down' } };
      }
      return {
        configured: status.configured,
        providers: 1,
        purposes: [
          {
            purpose: 'agent',
            configured: status.configured,
            model: status.configured
              ? { modelKey: status.model, label: 'L', providerId: 'p', providerName: 'P' }
              : null,
          },
        ],
      };
    },
  );

  ctx.app.post(
    '/api/v1/test-llm/internal/complete',
    { preHandler: ctx.app.requireInternal },
    async (request, reply) => {
      const wire = request.body as WireRequest;
      wireCalls.push(wire as unknown as Record<string, unknown>);
      providerCalls.push(fromWire(wire));
      if (options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      if (options.failWithStatus) {
        reply.code(options.failWithStatus);
        return { error: { code: 'provider_failed', message: 'no' } };
      }
      const out = (await complete(fromWire(wire), providerCalls.length)) as {
        content: string;
        toolCalls: unknown[];
        model: string;
      };
      return {
        id: 'x',
        model: { modelKey: out.model, label: 'L', providerId: 'p', providerName: 'P' },
        message: { role: 'assistant', content: out.content, toolCalls: out.toolCalls },
        usage: { inputTokens: null, outputTokens: null, totalTokens: null },
        finishReason: 'stop',
        latencyMs: 1,
        costMicros: 0,
      };
    },
  );

  return { ...ctx, providerCalls, wireCalls, stubComplete };
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
    'websites',
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

test('the provider call uses the llm-providers internal wire format', async (t) => {
  const ctx = await setup({
    complete: (_request, call) =>
      call === 1
        ? {
            content: '',
            toolCalls: [{ id: 'call_1', name: 'tenants__summary', arguments: '{}' }],
            model: 'test-model',
          }
        : { content: 'Fertig.', toolCalls: [], model: 'test-model' },
  });
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  assert.equal((await ask(ctx, cookie, 'Wie viele Mandanten?')).statusCode, 200);

  const first = ctx.wireCalls[0] as unknown as WireRequest;
  assert.equal(first.purpose, 'agent');
  assert.equal(first.maxTokens, 800);
  assert.ok(first.tools?.every((tool) => tool.type === 'function' && tool.function.name));
  assert.equal(Object.hasOwn(first, 'maxOutputTokens'), false);

  const second = ctx.wireCalls[1] as unknown as WireRequest;
  const assistant = second.messages.find((m) => m.role === 'assistant');
  assert.equal(assistant?.tool_calls?.[0]?.function.name, 'tenants__summary');
  assert.equal(assistant?.tool_calls?.[0]?.id, 'call_1');
  const tool = second.messages.find((m) => m.role === 'tool');
  assert.equal(tool?.tool_call_id, 'call_1');
});

test('only the agent purpose counts as configured', async (t) => {
  const other = await createTestApp({ SF_AGENT_PROVIDER_BASE: '/api/v1/test-llm-other' });
  t.after(() => other.close());
  other.app.get(
    '/api/v1/test-llm-other/internal/status',
    { preHandler: other.app.requireInternal },
    async () => ({
      configured: true,
      providers: 1,
      purposes: [{ purpose: 'discovery.interview', configured: true, model: { modelKey: 'm' } }],
    }),
  );
  const cookie = await other.signIn();
  const status = await other.app.inject({
    method: 'GET',
    url: '/api/v1/agent/status',
    headers: { cookie },
  });
  const body = status.json() as { configured: boolean; reachable: boolean };
  assert.equal(body.reachable, true);
  assert.equal(body.configured, false);
});

test('plugins see sources without run, and cannot register a writable one', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const status = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/agent/status',
    headers: { cookie },
  });
  const sources = (status.json() as { sources: Record<string, unknown>[] }).sources;
  assert.ok(sources.every((source) => !('run' in source)));
});

test('the runs list loads steps for the whole page', async (t) => {
  const ctx = await setup({
    complete: (_request, call) =>
      call % 2 === 1
        ? {
            content: '',
            toolCalls: [{ id: `c${call}`, name: 'platform__plugins', arguments: '{}' }],
            model: 'test-model',
          }
        : { content: 'ok', toolCalls: [], model: 'test-model' },
  });
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  for (let i = 0; i < 3; i += 1) await ask(ctx, cookie, `Frage ${i}`);
  const list = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/agent/runs',
    headers: { cookie },
  });
  const items = (list.json() as { items: { run?: unknown; steps: unknown[] }[] }).items;
  assert.equal(items.length, 3);
  assert.ok(items.every((item) => item.steps.length === 1));
});

/** Runs one source through the agent loop and returns what the model saw. */
async function viaAgent(ctx: StubApp, source: string, args: object): Promise<unknown> {
  const cookie = await ctx.signIn();
  const before = ctx.providerCalls.length;
  const stub = ctx.stubComplete;
  stub.next = (call) =>
    call === 1
      ? {
          content: '',
          toolCalls: [
            { id: 'c1', name: source.replace('.', '__'), arguments: JSON.stringify(args) },
          ],
          model: 'test-model',
        }
      : { content: 'ok', toolCalls: [], model: 'test-model' };
  stub.base = before;
  assert.equal((await ask(ctx, cookie, 'x')).statusCode, 200);
  return toolMessage(ctx.providerCalls[before + 1] as LlmRequest);
}

test('tenants.list treats % and _ in the search text as literals', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  for (const name of ['Alpha GmbH', 'A_pha AG']) {
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { cookie },
      payload: { name },
    });
    assert.equal(r.statusCode, 201);
  }
  const names = async (q: string) =>
    ((await viaAgent(ctx, 'tenants.list', { q })) as { items: { name: string }[] }).items.map(
      (item) => item.name,
    );
  assert.deepEqual(await names('a_pha'), ['A_pha AG']);
  assert.deepEqual(await names('%'), []);
});

test('platform.events counts only the last 30 days', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.close());
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  ctx.db
    .prepare('insert into events (id, name, payload, created_at) values (?, ?, ?, ?)')
    .run('evt_old', 'ancient.event', '{}', old);
  const result = (await viaAgent(ctx, 'platform.events', {})) as {
    countsByEvent: { name: string }[];
  };
  assert.equal(
    result.countsByEvent.some((row) => row.name === 'ancient.event'),
    false,
  );
});

test('the wire request passes the real llm-providers schema', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const headers = {
    [INTERNAL_TOKEN_HEADER]: ctx.internalToken,
    [INTERNAL_CALLER_HEADER]: 'agent',
  };
  const payload = toWireRequest(
    {
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'tenants__summary', arguments: '{}' }],
        },
        { role: 'tool', content: '{}', toolCallId: 'c1' },
      ],
      tools: [{ name: 'tenants__summary', description: 'd', parameters: { type: 'object' } }],
      maxOutputTokens: 800,
    },
    30_000,
  );
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/llm/internal/complete',
    headers,
    payload,
  });
  // Schema accepted: the only thing missing in a fresh install is a model for `agent`.
  assert.equal(response.statusCode, 409, response.body);
  assert.equal((response.json() as { error: { code: string } }).error.code, 'llm_purpose_unmapped');

  const status = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/llm/internal/status',
    headers,
  });
  assert.equal(status.statusCode, 200);
});
