import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTestApp } from './helpers.ts';

const INDEX = '<!doctype html><html><body><div id="root"></div></body></html>';
const ASSET = 'console.log("app");';
const SECRET = 'this file is not part of the build';

/**
 * A built SPA next to a file the server must never hand out. The secret sits
 * outside the web root, so any response carrying it proves path traversal.
 */
interface StaticFixture {
  root: string;
  webDir: string;
  dispose(): void;
}

function makeSpa(): StaticFixture {
  const root = mkdtempSync(join(tmpdir(), 'sf-web-'));
  const webDir = join(root, 'dist');
  mkdirSync(join(webDir, 'assets'), { recursive: true });
  writeFileSync(join(webDir, 'index.html'), INDEX);
  writeFileSync(join(webDir, 'assets', 'app.js'), ASSET);
  writeFileSync(join(root, 'secret.txt'), SECRET);
  return {
    root,
    webDir,
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('the SPA root serves the built index as HTML', async (t) => {
  const spa = makeSpa();
  const ctx = await createTestApp({ SF_WEB_DIR: spa.webDir });
  t.after(async () => {
    await ctx.close();
    spa.dispose();
  });

  const response = await ctx.app.inject({
    method: 'GET',
    url: '/',
    headers: { accept: 'text/html' },
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'] as string, /^text\/html; charset=utf-8/);
  assert.equal(response.body, INDEX);
});

test('hashed assets are served from the web root', async (t) => {
  const spa = makeSpa();
  const ctx = await createTestApp({ SF_WEB_DIR: spa.webDir });
  t.after(async () => {
    await ctx.close();
    spa.dispose();
  });

  const response = await ctx.app.inject({ method: 'GET', url: '/assets/app.js' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, ASSET);
});

test('a deep link is a client-side route and answers with the index', async (t) => {
  const spa = makeSpa();
  const ctx = await createTestApp({ SF_WEB_DIR: spa.webDir });
  t.after(async () => {
    await ctx.close();
    spa.dispose();
  });

  const response = await ctx.app.inject({
    method: 'GET',
    url: '/tenants',
    headers: { accept: 'text/html' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, INDEX);
});

test('an unknown API route stays JSON even when a browser asks for HTML', async (t) => {
  const spa = makeSpa();
  const ctx = await createTestApp({ SF_WEB_DIR: spa.webDir });
  t.after(async () => {
    await ctx.close();
    spa.dispose();
  });

  const response = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/nope',
    headers: { accept: 'text/html' },
  });
  assert.equal(response.statusCode, 404);
  assert.match(response.headers['content-type'] as string, /^application\/json/);
  assert.equal((response.json() as { error: { code: string } }).error.code, 'not_found');
});

test('an unknown API route answers JSON to a data client', async (t) => {
  const spa = makeSpa();
  const ctx = await createTestApp({ SF_WEB_DIR: spa.webDir });
  t.after(async () => {
    await ctx.close();
    spa.dispose();
  });

  const response = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/nope',
    headers: { accept: 'application/json' },
  });
  assert.equal(response.statusCode, 404);
  assert.equal((response.json() as { error: { code: string } }).error.code, 'not_found');
});

test('a path that climbs out of the web root leaks nothing', async (t) => {
  const spa = makeSpa();
  const ctx = await createTestApp({ SF_WEB_DIR: spa.webDir });
  t.after(async () => {
    await ctx.close();
    spa.dispose();
  });

  for (const url of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/../../secret.txt']) {
    const response = await ctx.app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 404, `${url} answered ${response.statusCode}`);
    assert.ok(!response.body.includes(SECRET), `${url} leaked the file outside the web root`);
  }
});

test('without a web directory the process stays API-only', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());

  const response = await ctx.app.inject({
    method: 'GET',
    url: '/',
    headers: { accept: 'text/html' },
  });
  assert.equal(response.statusCode, 404);
  assert.equal((response.json() as { error: { code: string } }).error.code, 'not_found');
});
