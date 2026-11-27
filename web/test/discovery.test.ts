import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { DiscoveryStep } from '../src/lib/types.ts';

const {
  answersForStep,
  missingRequired,
  initialValues,
  reorderRank,
  rankMoveLabel,
  aiNoticeFor,
  aiNoticeText,
} = await import('../src/pages/DiscoveryPublic.tsx');
const { getMessages } = await import('../src/lib/i18n.ts');
const { discoveryPublic, ApiError, DISCOVERY_TIMEOUT_MS, REQUEST_TIMEOUT_MS } =
  await import('../src/lib/api.ts');

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

  it('gives the model-backed steps a budget beyond the default request timeout', async () => {
    const timeouts: number[] = [];
    const originalTimeout = AbortSignal.timeout;
    AbortSignal.timeout = ((ms: number) => {
      timeouts.push(ms);
      return originalTimeout.call(AbortSignal, ms);
    }) as typeof AbortSignal.timeout;
    try {
      await discoveryPublic.state('abc');
      await discoveryPublic.advance('abc');
      await discoveryPublic.complete('abc');
    } finally {
      AbortSignal.timeout = originalTimeout;
    }

    assert.ok(DISCOVERY_TIMEOUT_MS > REQUEST_TIMEOUT_MS);
    assert.equal(timeouts.length, 3);
    assert.equal(timeouts[0], REQUEST_TIMEOUT_MS, 'a plain state read keeps 15 s');
    assert.deepEqual(timeouts.slice(1), [DISCOVERY_TIMEOUT_MS, DISCOVERY_TIMEOUT_MS]);
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

describe('reorderRank', () => {
  const options = [{ value: 'a' }, { value: 'b' }, { value: 'c' }];

  it('starts an untouched rank field from its visible options', () => {
    assert.deepEqual(reorderRank(undefined, options, 0, 1), ['b', 'a', 'c']);
  });

  it('keeps the guard at both ends', () => {
    assert.deepEqual(reorderRank(undefined, options, 0, -1), ['a', 'b', 'c']);
    assert.deepEqual(reorderRank(undefined, options, 2, 1), ['a', 'b', 'c']);
  });

  it('moves within a stored order', () => {
    assert.deepEqual(reorderRank(['c', 'a', 'b'], options, 2, -1), ['c', 'b', 'a']);
  });
});

describe('rankMoveLabel', () => {
  it('announces the arrow direction instead of next/back', () => {
    const de = getMessages('de');
    assert.equal(rankMoveLabel(de, 'up', 'Angebot'), 'Nach oben: Angebot');
    assert.equal(rankMoveLabel(de, 'down', 'Angebot'), 'Nach unten: Angebot');
    const en = getMessages('en');
    assert.equal(rankMoveLabel(en, 'up', 'Offer'), 'Move up: Offer');
    assert.equal(rankMoveLabel(en, 'down', 'Offer'), 'Move down: Offer');
  });
});

describe('initialValues on a rank field', () => {
  const rankStep: DiscoveryStep = {
    key: 'map.q10',
    phase: 'map',
    pending: false,
    fields: [
      {
        key: 'map.q10.order',
        kind: 'rank',
        required: true,
        label: { de: 'Reihenfolge', en: 'Order' },
        options: [
          { value: 'first', label: { de: 'Erstens', en: 'First' } },
          { value: 'second', label: { de: 'Zweitens', en: 'Second' } },
        ],
      },
    ],
  };

  it('prefills the visible order so an untouched field passes', () => {
    const values = initialValues(rankStep, {});
    assert.deepEqual(values['map.q10.order'], ['first', 'second']);
    assert.deepEqual(missingRequired(rankStep, values), {});
    assert.deepEqual(answersForStep(rankStep, values), [
      { key: 'map.q10.order', value: ['first', 'second'] },
    ]);
  });

  it('keeps a stored order', () => {
    const values = initialValues(rankStep, { 'map.q10.order': ['second', 'first'] });
    assert.deepEqual(values['map.q10.order'], ['second', 'first']);
  });
});

describe('discoveryInviteId', () => {
  it('decodes a normal id and refuses a broken percent escape', async () => {
    const { discoveryInviteId } = await import('../src/App.tsx');
    assert.equal(discoveryInviteId('/discovery/inv_123'), 'inv_123');
    assert.equal(discoveryInviteId('/discovery/%E0%A4%A'), null);
    assert.equal(discoveryInviteId('/discovery/a/b'), null);
  });
});

describe('aiNoticeFor', () => {
  const error = (code: string, status = 502) =>
    new ApiError(status, code, 'The AI answer was cut off by the token budget.');

  it('maps the cut-off answer to its own notice, not to the server text', () => {
    assert.equal(aiNoticeFor(error('discovery_ai_truncated')), 'truncated');
  });

  it('maps an outage and unusable JSON to the retryable notice', () => {
    assert.equal(aiNoticeFor(error('discovery_ai_unavailable', 503)), 'unavailable');
    assert.equal(aiNoticeFor(error('discovery_analysis_invalid')), 'unavailable');
  });

  it('reports the attempt limit without a retry, because a retry cannot help', () => {
    assert.equal(aiNoticeFor(error('discovery_complete_limit_reached', 429)), 'limit');
  });

  it('maps a filtered answer to its own notice, not to the budget one', () => {
    assert.equal(aiNoticeFor(error('discovery_ai_filtered', 422)), 'filtered');
    assert.notEqual(aiNoticeFor(error('discovery_ai_filtered', 422)), 'truncated');
  });

  it('leaves unrelated errors to the caller', () => {
    assert.equal(aiNoticeFor(new ApiError(409, 'discovery_token_used', 'x')), null);
    assert.equal(aiNoticeFor(new Error('boom')), null);
  });

  it('has a German and an English text for every notice', () => {
    for (const locale of ['de', 'en'] as const) {
      const messages = getMessages(locale);
      assert.ok(messages.discovery.aiTruncated.length > 20);
      assert.notEqual(messages.discovery.aiTruncated, messages.discovery.aiUnavailable);
      assert.ok(messages.discovery.aiLimitReached.length > 20);
      assert.ok(messages.discovery.aiFiltered.length > 20);
      assert.notEqual(messages.discovery.aiLimitReached, messages.discovery.aiTruncated);
    }
    const de = getMessages('de').discovery.aiTruncated;
    const en = getMessages('en').discovery.aiTruncated;
    assert.notEqual(de, en);
    // The customer must not read the English server message in the German UI.
    assert.ok(!de.includes('token budget'));
  });

  it('renders each notice from the catalogue, never from the server text', () => {
    const messages = getMessages('de');
    assert.equal(aiNoticeText('truncated', messages), messages.discovery.aiTruncated);
    assert.equal(aiNoticeText('unavailable', messages), messages.discovery.aiUnavailable);
    assert.equal(aiNoticeText('limit', messages), messages.discovery.aiLimitReached);
    assert.equal(aiNoticeText('filtered', messages), messages.discovery.aiFiltered);
  });
});
