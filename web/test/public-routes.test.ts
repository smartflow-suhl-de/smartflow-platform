import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { browser, setLocation } from './helpers/browser.ts';

const { isPublicPath, matchPublicRoute, publicRoutes } =
  await import('../src/lib/public-routes.ts');
const { App } = await import('../src/App.tsx');

describe('public path detection', () => {
  it('matches /d/:token and captures the token', () => {
    assert.equal(isPublicPath('/d/abc123'), true);
    assert.deepEqual(matchPublicRoute('/d/abc%20x')?.params, { token: 'abc x' });
  });

  it('leaves app routes and near misses alone', () => {
    for (const path of ['/', '/tenants', '/login', '/help', '/d', '/d/', '/d/a/b', '/x/d/a']) {
      assert.equal(isPublicPath(path), false, path);
    }
  });

  it('rejects a broken escape sequence instead of throwing', () => {
    assert.equal(isPublicPath('/d/%E0%A4%A'), false);
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
    const html = render('/d/test');
    assert.match(html, /<meta name="robots" content="noindex"\/>/);
    assert.match(html, /<title>SmartFlow (Plattform|Platform)<\/title>/);
    assert.match(html, /<h1[^>]*>[^<]*(nicht verfügbar|not available)/);
    assert.match(html, /href="#sf-main"/);
    assert.doesNotMatch(html, /Plattform wird geladen|sf-sidebar/);
    assert.deepEqual(calls, []);
  });

  it('renders the registered page with its params', () => {
    publicRoutes.push({
      pattern: '/d/:token',
      render: (params) => createElement('h1', null, `Seite ${params.token}`),
    });
    const html = render('/d/tok1/');
    assert.match(html, /<h1>Seite tok1<\/h1>/);
    assert.deepEqual(calls, []);
  });

  it('keeps /tenants on the session path (loading shell, no public layout)', () => {
    const html = render('/tenants');
    assert.match(html, /role="status"/);
    assert.doesNotMatch(html, /noindex/);
  });
});
