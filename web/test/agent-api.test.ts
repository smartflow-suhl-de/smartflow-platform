import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

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

const { ApiError, AGENT_TIMEOUT_MS, api, REQUEST_TIMEOUT_MS } = await import('../src/lib/api.ts');

const statusPayload = {
  configured: true,
  model: 'test-model',
  reachable: true,
  retentionDays: 90,
  limits: { perMinute: 10, perDay: 200 },
  sources: [{ id: 'tenants.summary', label: 'Mandanten', description: 'Anzahl', href: '/tenants' }],
};

const runPayload = {
  id: 'run_1',
  question: 'Wie viele Mandanten?',
  answer: 'Zwei.',
  status: 'ok',
  errorCode: null,
  model: 'test-model',
  durationMs: 120,
  createdAt: '2026-11-26T12:00:00.000Z',
  finishedAt: '2026-11-26T12:00:01.000Z',
  steps: [
    {
      seq: 1,
      source: 'tenants.summary',
      status: 'ok',
      durationMs: 12,
      truncated: false,
    },
  ],
};

describe('agent api client', () => {
  beforeEach(() => {
    calls = [];
    respond = () => jsonResponse(200, {});
  });

  it('parses the status with its sources and limits', async () => {
    respond = () => jsonResponse(200, statusPayload);
    const status = await api.agentStatus();

    assert.equal(calls[0]?.url, '/api/v1/agent/status');
    assert.equal(status.configured, true);
    assert.equal(status.model, 'test-model');
    assert.equal(status.limits.perDay, 200);
    assert.deepEqual(
      status.sources.map((source) => source.id),
      ['tenants.summary'],
    );
  });

  it('rejects a status without the configured flag instead of assuming it', async () => {
    respond = () => jsonResponse(200, { ...statusPayload, configured: undefined });

    await assert.rejects(
      () => api.agentStatus(),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'invalid_response');
        return true;
      },
    );
  });

  it('posts the question and waits longer than a normal request', async () => {
    respond = () => jsonResponse(200, { run: runPayload, sources: [], truncated: false });
    const answer = await api.agentAsk('Wie viele Mandanten?');

    assert.equal(calls[0]?.url, '/api/v1/agent/ask');
    assert.equal(calls[0]?.init.method, 'POST');
    assert.equal(calls[0]?.init.body, JSON.stringify({ question: 'Wie viele Mandanten?' }));
    assert.ok(AGENT_TIMEOUT_MS > REQUEST_TIMEOUT_MS);
    assert.equal(answer.run.answer, 'Zwei.');
    assert.equal(answer.run.steps.length, 1);
    assert.equal(answer.run.steps[0]?.source, 'tenants.summary');
  });

  it('builds the run list query and omits it when empty', async () => {
    respond = () => jsonResponse(200, { items: [runPayload], total: 1, nextCursor: null });
    await api.agentRuns({ limit: 5, cursor: 'abc' });
    assert.equal(calls[0]?.url, '/api/v1/agent/runs?limit=5&cursor=abc');

    calls = [];
    respond = () => jsonResponse(200, { items: [], total: 0, nextCursor: null });
    await api.agentRuns();
    assert.equal(calls[0]?.url, '/api/v1/agent/runs');
  });

  it('encodes the run id in the detail path', async () => {
    respond = () => jsonResponse(200, runPayload);
    await api.agentRun('run/1');

    assert.equal(calls[0]?.url, '/api/v1/agent/runs/run%2F1');
  });

  it('keeps an error run readable with its code', async () => {
    respond = () =>
      jsonResponse(200, {
        run: { ...runPayload, status: 'error', answer: null, errorCode: 'agent_provider_failed' },
        sources: [],
        truncated: false,
      });
    const answer = await api.agentAsk('Frage');

    assert.equal(answer.run.status, 'error');
    assert.equal(answer.run.answer, null);
    assert.equal(answer.run.errorCode, 'agent_provider_failed');
  });
});
