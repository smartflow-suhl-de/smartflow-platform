import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { DiscoveryStep } from '../src/lib/types.ts';

const { answersForStep, missingRequired } = await import('../src/pages/DiscoveryPublic.tsx');
const { discoveryPublic, ApiError } = await import('../src/lib/api.ts');

const step: DiscoveryStep = {
  key: 'map.q4',
  phase: 'map',
  pending: false,
  fields: [
    {
      key: 'map.q4.a',
      kind: 'text',
      required: true,
      maxLength: 600,
      label: { de: 'Ablauf 1', en: 'Process 1' },
    },
    {
      key: 'map.q4.b',
      kind: 'text',
      required: false,
      maxLength: 600,
      label: { de: 'Ablauf 2', en: 'Process 2' },
    },
    {
      key: 'map.q5.categories',
      kind: 'multi',
      required: true,
      label: { de: 'Kategorien', en: 'Categories' },
      options: [
        { value: 'email', label: { de: 'E-Mail', en: 'Email' } },
        { value: 'search', label: { de: 'Suche', en: 'Search' } },
      ],
    },
  ],
};

describe('answersForStep', () => {
  it('trims text answers and keeps the field key', () => {
    const answers = answersForStep(step, {
      'map.q4.a': '  Angebot schreiben  ',
      'map.q5.categories': ['email'],
    });
    assert.deepEqual(answers, [
      { key: 'map.q4.a', value: 'Angebot schreiben' },
      { key: 'map.q5.categories', value: ['email'] },
    ]);
  });

  it('drops empty optional fields but keeps an explicit empty required one', () => {
    const answers = answersForStep(step, {
      'map.q4.a': '',
      'map.q4.b': '',
      'map.q5.categories': ['email'],
    });
    assert.deepEqual(
      answers.map((entry) => entry.key),
      ['map.q4.a', 'map.q5.categories'],
    );
  });
});

describe('missingRequired', () => {
  it('flags an unanswered required text and an empty multi selection', () => {
    const errors = missingRequired(step, { 'map.q4.a': '   ', 'map.q5.categories': [] });
    assert.deepEqual(Object.keys(errors).sort(), ['map.q4.a', 'map.q5.categories']);
  });

  it('accepts a filled required answer and an empty optional field', () => {
    assert.deepEqual(
      missingRequired(step, { 'map.q4.a': 'Auftrag', 'map.q5.categories': ['email'] }),
      {},
    );
  });
});

describe('public discovery client', () => {
  const originalFetch = globalThis.fetch;
  let calls: Array<{ url: string; init: RequestInit | undefined }> = [];

  beforeEach(() => {
    calls = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ status: 'completed', report: { summary: 'Fertig' } }), {
        status: 410,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends no credentials and no cache, and treats 410 as data', async () => {
    const response = await discoveryPublic.state('abc');
    assert.equal(response.status, 410);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.init?.credentials, 'omit');
    assert.equal(calls[0]?.init?.cache, 'no-store');
    assert.match(calls[0]?.url ?? '', /\/api\/v1\/discovery\/public\/abc$/);
  });

  it('throws a typed error for a broken public route', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    await assert.rejects(
      () => discoveryPublic.state('abc'),
      (error: unknown) => error instanceof ApiError && error.code === 'rate_limited',
    );
  });
});
