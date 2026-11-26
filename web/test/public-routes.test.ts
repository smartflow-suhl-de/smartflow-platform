import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { browser, setLocation } from './helpers/browser.ts';

const { isPublicNamespace, isPublicPath, matchPublicRoute, publicRoutes } =
  await import('../src/lib/public-routes.ts');
const { App } = await import('../src/App.tsx');

describe('public path detection', () => {
  const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  it('matches /d/:token and captures an opaque token', () => {
    assert.equal(isPublicPath(`/d/${TOKEN}`), true);
    assert.deepEqual(matchPublicRoute(`/d/${TOKEN}`)?.params, { token: TOKEN });
  });

  it('rejects parameters that are not opaque ids', () => {
    for (const bad of [
      '..%2F..%2Ftenants',
      '%2e%2e', // the browser resolves this before the app, the matcher must still refuse it
      '..',
      '%00',
      'a%5Cb',
      'a%3Fb',
      'a%23b',
      'abc%20x',
      'short',
      'x'.repeat(65),
      '%E0%A4%A',
    ]) {
      assert.equal(isPublicPath(`/d/${bad}`), false, bad);
    }
  });

  it('treats the whole /d namespace as public', () => {
    for (const path of ['/d', '/d/a/b', '/d/..%2Fx', '/d/%E0%A4%A']) {
      assert.equal(isPublicNamespace(path), true, path);
    }
    for (const path of ['/', '/tenants', '/dx', '/x/d']) {
      assert.equal(isPublicNamespace(path), false, path);
    }
  });

  it('leaves app routes and near misses alone', () => {
    for (const path of ['/', '/tenants', '/login', '/help', '/d', '/d/', '/d/a/b', '/x/d/a']) {
      assert.equal(isPublicPath(path), false, path);
    }
  });
});

describe('App on public and app paths', () => {
  const realFetch = globalThis.fetch;
  let calls: string[];

  beforeEach(() => {
    browser.reset();
    calls = [];
    globalThis.fetch = (async (input: unknown) => {
      calls.push(String(input));
      throw new Error('network must not be used');
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    publicRoutes.length = 0;
  });

  function render(path: string): string {
    setLocation(path);
    return renderToStaticMarkup(createElement(App));
  }

  it('shows the unavailable notice with noindex and a title for an unserved link', () => {
    const html = render(`/d/${'B'.repeat(43)}`);
    assert.match(html, /<meta name="robots" content="noindex, nofollow"\/>/);
    assert.match(html, /<title>Dieser Link ist nicht verfügbar · SmartFlow Plattform<\/title>/);
    assert.match(html, /<h1[^>]*>[^<]*(nicht verfügbar|not available)/);
    assert.match(html, /href="#sf-main"/);
    assert.match(html, /<main id="sf-main" tabindex="-1"/);
    assert.doesNotMatch(html, /Plattform wird geladen|sf-sidebar/);
    assert.deepEqual(calls, []);
  });

  it('renders the registered page with its params', () => {
    publicRoutes.push({
      pattern: '/d/:token',
      title: () => 'Entdeckung',
      render: (params) => createElement('h1', null, `Seite ${params.token}`),
    });
    const html = render(`/d/${'C'.repeat(43)}/`);
    assert.match(html, /<title>Entdeckung · SmartFlow Plattform<\/title>/);
    assert.ok(html.includes(`<h1>Seite ${'C'.repeat(43)}</h1>`));
  });

  it('shows the notice for broken /d paths without any request', () => {
    for (const path of ['/d', '/d/', '/d/a/b', '/d/..%2F..%2Ftenants', '/d/%00', '/d/%E0%A4%A']) {
      calls.length = 0;
      const html = render(path);
      assert.match(html, /<meta name="robots" content="noindex, nofollow"\/>/, path);
      assert.match(html, /nicht verfügbar|not available/, path);
      assert.doesNotMatch(html, /Plattform wird geladen/, path);
      assert.deepEqual(calls, [], path);
    }
  });

  it('keeps /tenants on the session path (loading shell, no public layout)', () => {
    const html = render('/tenants');
    assert.match(html, /role="status"/);
    assert.doesNotMatch(html, /noindex/);
  });
});
