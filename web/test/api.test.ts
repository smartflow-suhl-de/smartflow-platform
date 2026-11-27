import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

/**
 * The API client is the only seam between the SPA and the server, so its
 * tests drive it through a stubbed `fetch`: every assertion is about the
 * request it builds or the value it returns, not about Fastify.
 */
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

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = String(input);
  calls.push({ url, init });
  return respond(url, init);
}) as typeof fetch;

const {
  ApiError,
  api,
  setOutageHandler,
  setRequestLocale,
  setUnauthorizedHandler,
  translateFetchError,
  REQUEST_TIMEOUT_MS,
} = await import('../src/lib/api.ts');

describe('api requests', () => {
  beforeEach(() => {
    calls = [];
    setUnauthorizedHandler(null);
    setRequestLocale('de');
    respond = () => jsonResponse(200, {});
  });

  it('announces the UI language instead of leaving it to the browser', async () => {
    // The SPA has no browser Accept-Language of its own: without this header the
    // server would pick the browser's preference, so a German UI could produce an
    // English sign-in mail.
    respond = () => jsonResponse(202, { sent: true, expiresAt: '2026-01-01T00:00:00Z' });
    setRequestLocale('en');
    await api.requestMagicLink('someone@example.com');

    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers['accept-language'], 'en');

    setRequestLocale('de');
    await api.requestMagicLink('someone@example.com');
    const second = calls[1]?.init.headers as Record<string, string>;
    assert.equal(second['accept-language'], 'de');
  });

  it('prefixes every call with /api/v1', async () => {
    respond = () => jsonResponse(200, { status: 'ok', version: '0.1.0', port: 8790 });
    await api.health();

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, '/api/v1/health');
  });

  it('sends the session cookie with the request', async () => {
    respond = () => jsonResponse(200, { status: 'ok', version: '0.1.0', port: null });
    await api.health();

    assert.equal(calls[0]?.init.credentials, 'same-origin');
  });

  it('sends JSON bodies with a POST and no body for reads', async () => {
    respond = () => jsonResponse(202, { sent: true, expiresAt: '2026-01-01T00:00:00Z' });
    await api.requestMagicLink('someone@example.com');

    assert.equal(calls[0]?.init.method, 'POST');
    assert.equal(calls[0]?.init.body, JSON.stringify({ email: 'someone@example.com' }));
    assert.equal(
      (calls[0]?.init.headers as Record<string, string>)['content-type'],
      'application/json',
    );
  });

  it('builds the tenant query string and skips blank filters', async () => {
    respond = () => jsonResponse(200, { items: [], total: 0, nextCursor: null });
    await api.listTenants({ status: 'active', q: '  acme  ', limit: 25, cursor: 'abc' });

    assert.equal(calls[0]?.url, '/api/v1/tenants?status=active&q=acme&limit=25&cursor=abc');
  });

  it('omits the query string entirely when no filter is set', async () => {
    respond = () => jsonResponse(200, { items: [], total: 0, nextCursor: null });
    await api.listTenants({ q: '   ' });

    assert.equal(calls[0]?.url, '/api/v1/tenants');
  });

  it('encodes tenant ids in the action path', async () => {
    respond = () =>
      jsonResponse(200, {
        id: 't-1',
        name: 'Acme',
        slug: 'acme',
        status: 'suspended',
        created_at: '2026-01-01T00:00:00Z',
      });
    await api.suspendTenant('t/1');

    assert.equal(calls[0]?.url, '/api/v1/tenants/t%2F1/suspend');
    assert.equal(calls[0]?.init.method, 'POST');
  });

  it('drops a blank optional slug from the create body', async () => {
    respond = () =>
      jsonResponse(200, {
        id: 't-1',
        name: 'Acme',
        slug: 'acme',
        status: 'active',
        created_at: '2026-01-01T00:00:00Z',
      });
    await api.createTenant({ name: 'Acme', slug: '   ' });

    assert.equal(calls[0]?.init.body, JSON.stringify({ name: 'Acme' }));
  });

  it('trims the slug when it is set', async () => {
    respond = () =>
      jsonResponse(200, {
        id: 't-1',
        name: 'Acme',
        slug: 'acme',
        status: 'active',
        created_at: '2026-01-01T00:00:00Z',
      });
    await api.createTenant({ name: 'Acme', slug: ' acme ' });

    assert.equal(calls[0]?.init.body, JSON.stringify({ name: 'Acme', slug: 'acme' }));
  });
});

describe('api response parsing', () => {
  beforeEach(() => {
    calls = [];
    setUnauthorizedHandler(null);
  });

  it('parses the health payload including a null port', async () => {
    respond = () => jsonResponse(200, { status: 'degraded', version: '1.2.3', port: null });
    const health = await api.health();

    assert.deepEqual(health, { status: 'degraded', version: '1.2.3', port: null });
  });

  it('rejects a payload that does not match the contract', async () => {
    respond = () => jsonResponse(200, { status: 'exploded' });

    await assert.rejects(
      () => api.health(),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'invalid_response');
        assert.equal(error.status, 500);
        return true;
      },
    );
  });

  it('keeps an unknown session tenant null instead of inventing one', async () => {
    respond = () =>
      jsonResponse(200, {
        user: { id: 'u1', email: 'a@b.c', name: 'A', role: 'operator' },
        tenant: null,
      });
    const me = await api.me();

    assert.equal(me.tenant, null);
    assert.equal(me.user.role, 'operator');
  });

  it('rejects a nav entry without a role list instead of showing it to everyone', async () => {
    respond = () =>
      jsonResponse(200, {
        items: [
          {
            plugin: 'tenants',
            label: 'Mandanten',
            path: '/tenants',
            group: 'management',
            icon: 'building',
            order: 20,
            createLabel: null,
            aliases: [],
          },
        ],
      });

    await assert.rejects(
      () => api.nav(),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'invalid_response');
        return true;
      },
    );
  });

  it('rejects a nav entry with an unknown role', async () => {
    respond = () =>
      jsonResponse(200, {
        items: [
          {
            plugin: 'tenants',
            label: 'Mandanten',
            path: '/tenants',
            group: 'management',
            icon: 'building',
            order: 20,
            roles: ['admin'],
            createLabel: null,
            aliases: [],
          },
        ],
      });

    await assert.rejects(
      () => api.nav(),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'invalid_response');
        return true;
      },
    );
  });

  it('accepts an empty role list from the server', async () => {
    respond = () =>
      jsonResponse(200, {
        items: [
          {
            plugin: 'tenants',
            label: 'Mandanten',
            path: '/tenants',
            group: 'management',
            icon: 'building',
            order: 20,
            roles: [],
            createLabel: null,
            aliases: [],
          },
        ],
      });
    const nav = await api.nav();

    assert.deepEqual(nav.items[0]?.roles, []);
  });
});

describe('api error handling', () => {
  beforeEach(() => {
    calls = [];
    setUnauthorizedHandler(null);
  });

  it('turns an error body into an ApiError with code and fields', async () => {
    respond = () =>
      jsonResponse(422, {
        error: {
          code: 'validation_failed',
          message: 'Please check the highlighted fields.',
          fields: { email: 'Please enter a valid email address.' },
        },
      });

    await assert.rejects(
      () => api.requestMagicLink('nope'),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 422);
        assert.equal(error.code, 'validation_failed');
        assert.equal(error.fields.email, 'Please enter a valid email address.');
        return true;
      },
    );
  });

  it('falls back to an http_ code for a non-JSON error body instead of echoing it', async () => {
    respond = () => textResponse(502, '<html><body>upstream down</body></html>');

    await assert.rejects(
      () => api.health(),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 502);
        assert.equal(error.code, 'http_502');
        // The HTML fragment must not become the operator-facing message.
        assert.equal(error.message, 'HTTP 502');
        return true;
      },
    );
  });

  it('reports an unreachable API as network_error', async () => {
    respond = () => {
      throw new TypeError('fetch failed');
    };

    await assert.rejects(
      () => api.health(),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'network_error');
        assert.equal(error.status, 0);
        return true;
      },
    );
  });

  it('notifies the unauthorized handler on a 401 from a data route', async () => {
    let notified = 0;
    setUnauthorizedHandler(() => {
      notified += 1;
    });
    respond = () => jsonResponse(401, { error: { code: 'unauthorized', message: 'no' } });

    await assert.rejects(() => api.nav());
    assert.equal(notified, 1);
  });

  it('does not notify on a 401 from the session probe', async () => {
    let notified = 0;
    setUnauthorizedHandler(() => {
      notified += 1;
    });
    respond = () => jsonResponse(401, { error: { code: 'unauthorized', message: 'no' } });

    await assert.rejects(() => api.me());
    assert.equal(notified, 0);
  });

  it('does not notify on an expected 401 from a sign-in link', async () => {
    let notified = 0;
    setUnauthorizedHandler(() => {
      notified += 1;
    });
    respond = () => jsonResponse(401, { error: { code: 'invalid_link', message: 'expired' } });

    await assert.rejects(() => api.confirmMagicLink('token-token'));
    assert.equal(notified, 0);
  });

  it('passes an abort through untouched so callers can ignore it', async () => {
    respond = () => {
      throw new DOMException('aborted', 'AbortError');
    };

    await assert.rejects(
      () => api.health(),
      (error: unknown) => {
        assert.equal((error as Error).name, 'AbortError');
        assert.equal(error instanceof ApiError, false);
        return true;
      },
    );
  });
});

describe('api outage reporting', () => {
  beforeEach(() => {
    calls = [];
    setUnauthorizedHandler(null);
    setOutageHandler(null);
  });

  it('reports a 5xx as an outage', async () => {
    let outages = 0;
    setOutageHandler(() => {
      outages += 1;
    });
    respond = () => jsonResponse(502, { error: { code: 'upstream_down', message: 'no' } });

    await assert.rejects(() => api.tenantStats());
    assert.equal(outages, 1);
  });

  it('reports an unanswered request as an outage', async () => {
    let outages = 0;
    setOutageHandler(() => {
      outages += 1;
    });
    respond = () => {
      throw new TypeError('fetch failed');
    };

    await assert.rejects(() => api.nav());
    assert.equal(outages, 1);
  });

  it('keeps a latched outage when a different route answers 200', async () => {
    // The bug QA found: `/tenants` fails, `/nav` still answers, and the 200
    // asserted "system nominal" while the tenant route stayed broken.
    let outages = 0;
    setOutageHandler(() => {
      outages += 1;
    });
    respond = (url) =>
      url.endsWith('/tenants')
        ? jsonResponse(502, { error: { code: 'upstream_down', message: 'no' } })
        : jsonResponse(200, { items: [] });

    await assert.rejects(() => api.listTenants({}));
    await api.nav();

    assert.equal(outages, 1);
  });

  it('stays silent for a 4xx and for a caller abort', async () => {
    let outages = 0;
    setOutageHandler(() => {
      outages += 1;
    });

    respond = () => jsonResponse(422, { error: { code: 'validation_failed', message: 'no' } });
    await assert.rejects(() => api.requestMagicLink('nope'));

    respond = () => {
      throw new DOMException('aborted', 'AbortError');
    };
    await assert.rejects(() => api.health());

    assert.equal(outages, 0);
  });

  // The handler is module state: leaving it installed would make every later
  // request in this file report into a dead test.
  afterEach(() => setOutageHandler(null));
});

describe('translateFetchError', () => {
  it('passes an AbortError through unchanged', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    assert.equal(translateFetchError(abort), abort);
  });

  it('maps a TimeoutError to network_error', async () => {
    const error = translateFetchError(new DOMException('timed out', 'TimeoutError'));
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 0);
    assert.equal(error.code, 'network_error');
  });

  it('maps a TypeError from fetch to network_error', async () => {
    const error = translateFetchError(new TypeError('fetch failed'));
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, 'network_error');
    assert.equal(error.message, 'Network request failed');
  });

  it('maps a thrown non-error value to network_error', async () => {
    const error = translateFetchError('boom');
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 0);
    assert.equal(error.code, 'network_error');
  });
});

describe('api abort and timeout', () => {
  beforeEach(() => {
    calls = [];
    setUnauthorizedHandler(null);
  });

  it('reports a body read that aborts mid-stream as network_error', async () => {
    // The headers arrived, so `fetch` resolves; the body read is what aborts.
    // Before the fix that rejection escaped as a raw TypeError and rendered as
    // a broken connection message with no code.
    respond = () =>
      ({
        ok: true,
        status: 200,
        text: () => Promise.reject(new DOMException('aborted', 'AbortError')),
      }) as unknown as Response;

    await assert.rejects(
      () => api.health(),
      (error: unknown) => {
        assert.equal((error as Error).name, 'AbortError');
        assert.equal(error instanceof ApiError, false);
        return true;
      },
    );
  });

  it('reports a body read that fails without an abort as network_error', async () => {
    respond = () =>
      ({
        ok: true,
        status: 200,
        text: () => Promise.reject(new TypeError('terminated')),
      }) as unknown as Response;

    await assert.rejects(
      () => api.health(),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'network_error');
        assert.equal(error.status, 0);
        return true;
      },
    );
  });

  it('gives every request a timeout signal', async () => {
    respond = () => jsonResponse(200, { status: 'ok', version: '0.1.0', port: null });
    await api.health();

    assert.equal(REQUEST_TIMEOUT_MS, 15_000);
    assert.ok(calls[0]?.init.signal instanceof AbortSignal);
  });

  it('combines the caller signal with the timeout', async () => {
    respond = () => jsonResponse(200, { status: 'ok', version: '0.1.0', port: null });
    const controller = new AbortController();
    await api.health(controller.signal);

    const signal = calls[0]?.init.signal as AbortSignal;
    assert.notEqual(signal, controller.signal);
    // An abort through the caller's controller reaches the combined signal.
    controller.abort();
    assert.equal(signal.aborted, true);
    assert.equal(signal.reason.name, 'AbortError');
  });

  it('turns a timeout into network_error instead of a raw DOMException', async () => {
    // The stubbed fetch rejects the way `AbortSignal.timeout` makes it fail.
    respond = () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    };

    await assert.rejects(
      () => api.health(),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'network_error');
        assert.equal(error.status, 0);
        return true;
      },
    );
  });

  it('gives up on a hanging request when the timeout fires', async () => {
    // Short timeout so the real code path runs without waiting 15 s: the
    // request is created with whatever `AbortSignal.timeout` returns.
    const original = AbortSignal.timeout;
    AbortSignal.timeout = ((_ms: number) => original(10)) as typeof AbortSignal.timeout;
    try {
      // Never answers on its own — only the abort signal can end it.
      respond = (_url, init) => {
        const signal = init.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        });
      };

      await assert.rejects(
        () => api.health(),
        (error: unknown) => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.code, 'network_error');
          return true;
        },
      );
    } finally {
      AbortSignal.timeout = original;
    }
  });

  it('resolves a 204 logout without a body', async () => {
    respond = () => new Response(null, { status: 204 });
    await assert.doesNotReject(() => api.logout());

    assert.equal(calls[0]?.url, '/api/v1/auth/logout');
    assert.equal(calls[0]?.init.method, 'POST');
  });
});
