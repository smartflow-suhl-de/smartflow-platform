import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

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

const { ApiError, api, setUnauthorizedHandler } = await import('../src/lib/api.ts');

describe('api requests', () => {
  beforeEach(() => {
    calls = [];
    setUnauthorizedHandler(null);
    respond = () => jsonResponse(200, {});
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

  it('normalises a missing nav role list to an empty array', async () => {
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

  it('falls back to an http_ code when the body has no error object', async () => {
    respond = () => textResponse(502, 'upstream down');

    await assert.rejects(
      () => api.health(),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 502);
        assert.equal(error.code, 'invalid_body');
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
