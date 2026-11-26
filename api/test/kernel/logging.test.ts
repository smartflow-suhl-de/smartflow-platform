import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestApp } from './helpers.ts';

const SEARCH_TERM = 'geheim';
const LINK_TOKEN = 'tok_live_geheim';

/** Collects what pino writes instead of sending it to stdout. */
function captureLog(): { lines: string[]; write(line: string): void } {
  const lines: string[] = [];
  return {
    lines,
    write(line: string) {
      lines.push(line);
    },
  };
}

/** Waits for the completion line, which `inject` does not await. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test('the request log keeps method, path and status but never the search term', async (t) => {
  const log = captureLog();
  const ctx = await createTestApp({ SF_LOG_LEVEL: 'info' }, { logStream: log });
  t.after(() => ctx.close());

  const cookie = await ctx.signIn();
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/tenants?q=${SEARCH_TERM}&limit=10`,
    headers: { cookie },
  });
  assert.equal(response.statusCode, 200);

  await settle();
  const output = log.lines.join('\n');

  assert.match(output, /"method":"GET"/);
  assert.match(output, /"url":"\/api\/v1\/tenants"/);
  assert.match(output, /"statusCode":200/);
  assert.equal(output.includes(SEARCH_TERM), false, 'the search term reached the log');
  assert.equal(output.includes('limit=10'), false, 'the query string reached the log');
});

test('the request log drops any query value, not only q', async (t) => {
  const log = captureLog();
  const ctx = await createTestApp({ SF_LOG_LEVEL: 'info' }, { logStream: log });
  t.after(() => ctx.close());

  // Query values can carry credentials (an old bookmark, a token in a shared
  // link); the log must keep the path and drop the rest.
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/health?token=${LINK_TOKEN}`,
  });
  assert.equal(response.statusCode, 200);

  await settle();
  const output = log.lines.join('\n');

  assert.match(output, /"url":"\/api\/v1\/health"/);
  assert.equal(output.includes(LINK_TOKEN), false, 'the link token reached the log');
});
