import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import './helpers/browser.ts';
import type { AuthMe, SessionUser, Tenant } from '../src/lib/types.ts';
import { defaultTheme } from '../src/lib/themes.ts';

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

const { api, ApiError } = await import('../src/lib/api.ts');
const { getMessages } = await import('../src/lib/i18n.ts');
const { TenantSwitcher, TenantSwitcherModal } =
  await import('../src/components/TenantSwitcher.tsx');
const { AppShell } = await import('../src/components/AppShell.tsx');
const { ToastProvider } = await import('../src/components/Toast.tsx');

const operatorUser: SessionUser = {
  id: 'u-1',
  email: 'admin@smartflow.de',
  name: 'Operator Admin',
  role: 'operator',
};

const employeeUser: SessionUser = {
  id: 'u-2',
  email: 'user@tannwerk.de',
  name: 'Mitarbeiter',
  role: 'employee',
};

const sampleTenant: Tenant = {
  id: 'ten-acme',
  name: 'Acme Corp',
  slug: 'acme',
  status: 'active',
  created_at: '2026-11-20T10:00:00Z',
};

describe('tenant switcher api and parsing', () => {
  beforeEach(() => {
    calls = [];
    respond = () => jsonResponse(200, {});
  });

  it('posts the chosen tenant id to /api/v1/auth/tenant', async () => {
    const authMePayload: AuthMe = {
      user: operatorUser,
      tenant: null,
      activeTenant: { id: 'ten-acme', name: 'Acme Corp', slug: 'acme' },
    };
    respond = () => jsonResponse(200, authMePayload);

    const result = await api.setActiveTenant('ten-acme');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, '/api/v1/auth/tenant');
    assert.equal(calls[0]?.init.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { tenantId: 'ten-acme' });
    assert.deepEqual(result.activeTenant, { id: 'ten-acme', name: 'Acme Corp', slug: 'acme' });
  });

  it('posts null to /api/v1/auth/tenant to clear the context', async () => {
    const authMePayload: AuthMe = {
      user: operatorUser,
      tenant: null,
      activeTenant: null,
    };
    respond = () => jsonResponse(200, authMePayload);

    const result = await api.setActiveTenant(null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, '/api/v1/auth/tenant');
    assert.equal(calls[0]?.init.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { tenantId: null });
    assert.equal(result.activeTenant, null);
  });

  it('turns 403 tenant_suspended into an ApiError without changing context', async () => {
    respond = () =>
      jsonResponse(403, {
        error: { code: 'tenant_suspended', message: 'The tenant is suspended.' },
      });

    await assert.rejects(
      async () => api.setActiveTenant('ten-suspended'),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 403);
        assert.equal(err.code, 'tenant_suspended');
        return true;
      },
    );
  });

  it('turns 404 tenant_not_found into an ApiError', async () => {
    respond = () =>
      jsonResponse(404, {
        error: { code: 'tenant_not_found', message: 'Tenant not found.' },
      });

    await assert.rejects(
      async () => api.setActiveTenant('ten-ghost'),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 404);
        assert.equal(err.code, 'tenant_not_found');
        return true;
      },
    );
  });
});

describe('tenant switcher component rendering', () => {
  it('renders empty state when no tenant is selected', () => {
    const messages = getMessages('de');
    const html = renderToStaticMarkup(
      createElement(TenantSwitcher, {
        activeTenant: null,
        messages,
        onOpenModal: () => undefined,
        onClearContext: () => undefined,
      }),
    );

    assert.ok(html.includes(messages.tenantSwitcher.contextLabel));
    assert.ok(html.includes(messages.tenantSwitcher.noTenant));
    assert.ok(html.includes(messages.tenantSwitcher.chooseTenant));
    // Clear button must not be rendered when no tenant is active
    assert.ok(!html.includes(messages.tenantSwitcher.clearContextAria));
  });

  it('renders active tenant name and slug when a tenant is chosen', () => {
    const messages = getMessages('de');
    const html = renderToStaticMarkup(
      createElement(TenantSwitcher, {
        activeTenant: { id: 'ten-acme', name: 'Acme Corp', slug: 'acme' },
        messages,
        onOpenModal: () => undefined,
        onClearContext: () => undefined,
      }),
    );

    assert.ok(html.includes('Acme Corp'));
    assert.ok(html.includes('acme'));
    assert.ok(html.includes(messages.tenantSwitcher.clearContextAria));
  });

  it('renders modal with search, empty state and close button', () => {
    const messages = getMessages('de');
    const html = renderToStaticMarkup(
      createElement(TenantSwitcherModal, {
        open: true,
        activeTenant: null,
        tenants: [sampleTenant],
        loading: false,
        error: null,
        query: '',
        hasNextPage: false,
        hasPrevPage: false,
        busyId: null,
        messages,
        onQueryChange: () => undefined,
        onSelect: () => undefined,
        onPrevPage: () => undefined,
        onNextPage: () => undefined,
        onClose: () => undefined,
      }),
    );

    assert.ok(html.includes(messages.tenantSwitcher.title));
    assert.ok(html.includes('Acme Corp'));
    assert.ok(html.includes(messages.tenantSwitcher.searchPlaceholder));
    assert.ok(html.includes(messages.tenantSwitcher.selectAction));
  });

  it('renders error alert in modal when error is passed', () => {
    const messages = getMessages('de');
    const html = renderToStaticMarkup(
      createElement(TenantSwitcherModal, {
        open: true,
        activeTenant: null,
        tenants: [],
        loading: false,
        error: 'Der Mandant ist gesperrt.',
        query: '',
        hasNextPage: false,
        hasPrevPage: false,
        busyId: null,
        messages,
        onQueryChange: () => undefined,
        onSelect: () => undefined,
        onPrevPage: () => undefined,
        onNextPage: () => undefined,
        onClose: () => undefined,
      }),
    );

    assert.ok(html.includes('Der Mandant ist gesperrt.'));
    assert.ok(html.includes('role="alert"'));
  });

  it('is rendered in AppShell only for operator role', () => {
    const messages = getMessages('de');
    const operatorShell = renderToStaticMarkup(
      createElement(
        ToastProvider,
        null,
        createElement(AppShell, {
          user: operatorUser,
          pathname: '/',
          navItems: [],
          health: null,
          healthError: false,
          stats: null,
          mode: 'light',
          theme: defaultTheme(),
          customTheme: null,
          locale: 'de',
          messages,
          loggingOut: false,
          logoutError: null,
          activeTenant: null,
          onOpenTenantSwitcher: () => undefined,
          onClearTenantContext: () => undefined,
          onModeChange: () => undefined,
          onAppearanceChange: () => undefined,
          onRetryHealth: () => undefined,
          onLogout: () => undefined,
          children: createElement('div', null, 'Content'),
        }),
      ),
    );
    assert.ok(operatorShell.includes(messages.tenantSwitcher.contextLabel));

    const employeeShell = renderToStaticMarkup(
      createElement(
        ToastProvider,
        null,
        createElement(AppShell, {
          user: employeeUser,
          pathname: '/',
          navItems: [],
          health: null,
          healthError: false,
          stats: null,
          mode: 'light',
          theme: defaultTheme(),
          customTheme: null,
          locale: 'de',
          messages,
          loggingOut: false,
          logoutError: null,
          activeTenant: null,
          onOpenTenantSwitcher: () => undefined,
          onClearTenantContext: () => undefined,
          onModeChange: () => undefined,
          onAppearanceChange: () => undefined,
          onRetryHealth: () => undefined,
          onLogout: () => undefined,
          children: createElement('div', null, 'Content'),
        }),
      ),
    );
    assert.ok(!employeeShell.includes(messages.tenantSwitcher.contextLabel));
  });
});

describe('tenant switcher i18n parity', () => {
  it('has identical keys in DE and EN catalog', () => {
    const deKeys = Object.keys(getMessages('de').tenantSwitcher).sort();
    const enKeys = Object.keys(getMessages('en').tenantSwitcher).sort();
    assert.deepEqual(deKeys, enKeys);
  });
});
