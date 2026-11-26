import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

interface Call {
  url: string;
  init: RequestInit;
}

let calls: Call[] = [];
const pendingResolvers: Array<() => void> = [];

function releaseAll(): void {
  while (pendingResolvers.length > 0) {
    pendingResolvers.pop()?.();
  }
}

globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  calls.push({ url: String(input), init });
  await new Promise<void>((resolve) => {
    pendingResolvers.push(resolve);
  });
  return new Response(
    JSON.stringify({
      user: { id: 'u1', email: 'a@b.c', name: 'A', role: 'operator' },
      tenant: null,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}) as typeof fetch;

const {
  confirmMagicLinkOnce,
  pendingConfirmationCount,
  sessionProbeOutcome,
  toAppHref,
  tokenFromSearch,
} = await import('../src/lib/auth-flow.ts');
const { ApiError } = await import('../src/lib/api.ts');

describe('confirmMagicLinkOnce', () => {
  beforeEach(() => {
    calls = [];
    pendingResolvers.length = 0;
  });

  it('spends a token only once when called twice in the same tick', async () => {
    const first = confirmMagicLinkOnce('token-aaaaaaaaaa');
    const second = confirmMagicLinkOnce('token-aaaaaaaaaa');

    assert.equal(first, second, 'the second call must reuse the first promise');

    releaseAll();
    await first;
    assert.equal(calls.length, 1);
  });

  it('runs separate tokens independently', async () => {
    const first = confirmMagicLinkOnce('token-aaaaaaaaaa');
    const second = confirmMagicLinkOnce('token-bbbbbbbbbb');

    assert.notEqual(first, second);

    releaseAll();
    await Promise.all([first, second]);
    assert.equal(calls.length, 2);
  });

  it('forgets a token after the request settles so a retry still works', async () => {
    const first = confirmMagicLinkOnce('token-aaaaaaaaaa');
    assert.equal(pendingConfirmationCount(), 1);

    releaseAll();
    await first;
    assert.equal(pendingConfirmationCount(), 0);

    const retry = confirmMagicLinkOnce('token-aaaaaaaaaa');
    releaseAll();
    await retry;
    assert.equal(calls.length, 2);
  });

  it('posts the token to the confirm endpoint', async () => {
    const pending = confirmMagicLinkOnce('token-aaaaaaaaaa');
    releaseAll();
    await pending;

    assert.equal(calls[0]?.url, '/api/v1/auth/confirm');
    assert.equal(calls[0]?.init.method, 'POST');
    assert.equal(calls[0]?.init.body, JSON.stringify({ token: 'token-aaaaaaaaaa' }));
  });
});

describe('tokenFromSearch', () => {
  it('reads the token from the query string', () => {
    assert.equal(tokenFromSearch('?token=abc'), 'abc');
  });

  it('returns null without a token', () => {
    assert.equal(tokenFromSearch(''), null);
    assert.equal(tokenFromSearch('?other=1'), null);
  });

  it('rejects a blank token', () => {
    assert.equal(tokenFromSearch('?token='), null);
    assert.equal(tokenFromSearch('?token=%20%20'), null);
  });

  it('decodes an encoded token', () => {
    assert.equal(tokenFromSearch('?token=a%2Bb'), 'a+b');
  });
});

describe('sessionProbeOutcome', () => {
  it('treats a 401 as signed out', () => {
    assert.equal(sessionProbeOutcome(new ApiError(401, 'unauthorized', 'no')), 'signed_out');
  });

  it('keeps the session when the API is unreachable', () => {
    assert.equal(sessionProbeOutcome(new ApiError(0, 'network_error', 'down')), 'unavailable');
    assert.equal(sessionProbeOutcome(new ApiError(502, 'http_502', 'HTTP 502')), 'unavailable');
    assert.equal(
      sessionProbeOutcome(new ApiError(500, 'invalid_response', 'bad payload')),
      'unavailable',
    );
  });

  it('reports an abort as aborted, never as a session state', () => {
    assert.equal(sessionProbeOutcome(new DOMException('aborted', 'AbortError')), 'aborted');
  });

  it('treats any other failure as unavailable', () => {
    assert.equal(sessionProbeOutcome(new Error('boom')), 'unavailable');
  });

  it('never treats a non-ApiError as signed out', () => {
    for (const error of [new TypeError('fetch failed'), 'boom', undefined, null]) {
      assert.notEqual(sessionProbeOutcome(error), 'signed_out', String(error));
    }
  });
});

describe('toAppHref', () => {
  const origin = 'http://127.0.0.1:5273';

  it('reduces an absolute link to path and query', () => {
    assert.equal(
      toAppHref(`${origin}/login/confirm?token=abc`, origin),
      '/login/confirm?token=abc',
    );
  });

  it('keeps a relative link as it is', () => {
    assert.equal(toAppHref('/login/confirm?token=abc', origin), '/login/confirm?token=abc');
  });

  it('falls back to the login route for an unparsable link instead of throwing', () => {
    assert.equal(toAppHref('http://[::bad', origin), '/login');
  });

  it('refuses a link with a foreign scheme', () => {
    assert.equal(toAppHref('javascript:alert(1)', origin), '/login');
    assert.equal(toAppHref('data:text/html,<script>x</script>', origin), '/login');
    assert.equal(toAppHref('x:javascript:alert(1)', origin), '/login');
  });

  it('refuses a link to another origin', () => {
    assert.equal(toAppHref('https://evil.example/login/confirm?token=abc', origin), '/login');
  });
});
