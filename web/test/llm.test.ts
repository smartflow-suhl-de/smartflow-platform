import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

interface Call {
  url: string;
  init: RequestInit;
}

let calls: Call[] = [];
let respond: (url: string, init: RequestInit) => Response | Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = String(input);
  calls.push({ url, init });
  return respond(url, init);
}) as typeof fetch;

const { ApiError, api, setOutageHandler } = await import('../src/lib/api.ts');
const { formatCost, formatTokens } = await import('../src/pages/LlmProviders.tsx');

const provider = {
  id: 'llm_p_abc',
  name: 'Internes Gateway',
  preset: 'custom',
  baseUrl: 'https://llm.example/v1',
  chatPath: '/chat/completions',
  apiVersion: null,
  authStyle: 'bearer',
  authHeader: 'Authorization',
  keySet: true,
  keyUpdatedAt: '2026-11-26T09:00:00.000Z',
  extraHeaderNames: ['X-Organization'],
  timeoutMs: 30000,
  maxRetries: 1,
  rateLimitPerMinute: 60,
  dailyTokenLimit: 0,
  monthlyBudgetMicros: 0,
  retentionDays: 90,
  allowedPlugins: ['agent'],
  status: 'active',
  lastTestAt: '2026-11-26T09:10:00.000Z',
  lastTestStatus: 'ok',
  lastTestMs: 184,
  createdAt: '2026-11-26T08:00:00.000Z',
  updatedAt: '2026-11-26T09:00:00.000Z',
  createdBy: 'usr_operator',
  modelCount: 3,
};

describe('LLM API client', () => {
  beforeEach(() => {
    calls = [];
    respond = () => jsonResponse(200, {});
  });

  afterEach(() => {
    calls = [];
  });

  it('lists providers with filters and parses the DTO', async () => {
    respond = () => jsonResponse(200, { items: [provider], total: 1, nextCursor: null });

    const page = await api.listLlmProviders({ status: 'active', q: 'gateway', limit: 10 });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, '/api/v1/llm/providers?status=active&q=gateway&limit=10');
    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.name, 'Internes Gateway');
    assert.equal(page.items[0]?.keySet, true);
    assert.deepEqual(page.items[0]?.allowedPlugins, ['agent']);
    assert.equal('apiKey' in (page.items[0] ?? {}), false);
  });

  it('creates a provider with a POST body', async () => {
    respond = () => jsonResponse(201, provider);

    await api.createLlmProvider({
      name: 'Internes Gateway',
      baseUrl: 'https://llm.example/v1',
      authStyle: 'bearer',
      apiKey: 'secret-in-request-only',
    });

    assert.equal(calls[0]?.url, '/api/v1/llm/providers');
    assert.equal(calls[0]?.init.method, 'POST');
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    assert.equal(body.name, 'Internes Gateway');
    assert.equal(body.baseUrl, 'https://llm.example/v1');
    assert.equal(body.authStyle, 'bearer');
  });

  it('parses purposes with their nested model', async () => {
    respond = () =>
      jsonResponse(200, {
        items: [
          {
            purpose: 'chat.default',
            description: null,
            model: {
              id: 'llm_m_1',
              modelKey: 'qwen3-32b',
              label: 'Qwen3 32B',
              providerId: 'llm_p_abc',
              providerName: 'Internes Gateway',
              status: 'active',
              capabilities: { tools: true, json: true, vision: false, embeddings: false },
            },
            fallbackModel: null,
            updatedAt: '2026-11-26T09:00:00.000Z',
            updatedBy: 'usr_operator',
            calls30d: 1284,
          },
        ],
      });

    const purposes = await api.listLlmPurposes();

    assert.equal(purposes[0]?.purpose, 'chat.default');
    assert.equal(purposes[0]?.model?.modelKey, 'qwen3-32b');
    assert.equal(purposes[0]?.model?.capabilities.tools, true);
    assert.equal(purposes[0]?.calls30d, 1284);
  });

  it('parses a provider test result including a failure code', async () => {
    respond = () =>
      jsonResponse(200, {
        ok: false,
        latencyMs: 91,
        code: 'llm_provider_auth',
        message: 'The provider rejected the credentials.',
      });

    const result = await api.testLlmProvider({ baseUrl: 'https://llm.example/v1' });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'llm_provider_auth');
    assert.equal(result.models, undefined);
  });

  it('sends DELETE for a provider', async () => {
    respond = () => new Response(null, { status: 204 });

    await api.deleteLlmProvider('llm_p_abc');

    assert.equal(calls[0]?.url, '/api/v1/llm/providers/llm_p_abc');
    assert.equal(calls[0]?.init.method, 'DELETE');
  });

  it('parses the usage summary', async () => {
    respond = () =>
      jsonResponse(200, {
        days: 30,
        calls: 1684,
        ok: 1677,
        errors: 7,
        inputTokens: 7_100_000,
        outputTokens: 1_600_000,
        costMicros: 4_120_000,
        byCaller: [{ caller: 'agent', calls: 1284, tokens: 6_900_000, costMicros: 2_840_000 }],
        byProvider: [
          {
            providerId: 'llm_p_abc',
            providerName: 'Internes Gateway',
            calls: 402,
            costMicros: 0,
          },
        ],
        byPurpose: [{ purpose: 'chat.default', calls: 1284, costMicros: 2_840_000 }],
      });

    const summary = await api.llmUsageSummary(30);

    assert.equal(summary.calls, 1684);
    assert.equal(summary.errors, 7);
    assert.equal(summary.byCaller[0]?.tokens, 6_900_000);
    assert.equal(summary.byProvider[0]?.providerName, 'Internes Gateway');
  });

  it('does not report an outage for an LLM provider failure', async () => {
    let outage = false;
    setOutageHandler(() => {
      outage = true;
    });
    respond = () =>
      jsonResponse(502, {
        error: { code: 'llm_provider_error', message: 'The provider rejected the request.' },
      });

    await assert.rejects(
      () => api.listLlmProviders({ limit: 1 }),
      (error: unknown) => error instanceof ApiError && error.code === 'llm_provider_error',
    );
    assert.equal(outage, false);
    setOutageHandler(null);
  });

  it('still reports a generic 5xx as an outage', async () => {
    let outage = false;
    setOutageHandler(() => {
      outage = true;
    });
    respond = () => jsonResponse(500, { error: { code: 'internal_error', message: 'boom' } });

    await assert.rejects(() => api.llmUsageSummary(30));
    assert.equal(outage, true);
    setOutageHandler(null);
  });

  it('formats costs and token counts per locale', () => {
    assert.match(formatCost(4_120_000, 'de'), /4,12/);
    assert.equal(formatTokens(999, 'de'), '999');
    assert.match(formatTokens(8_700_000, 'de'), /8,7/);
  });
});
