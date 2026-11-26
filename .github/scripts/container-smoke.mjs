#!/usr/bin/env node
// Starts the built image and checks it from the outside.
//
// The probes run inside the container instead of through a published port:
// some sandboxes cannot publish ports (user namespaces), while the contract we
// care about is "the process serves HTTP as the node user".
import { spawnSync } from 'node:child_process';

const image = process.env.SMOKE_IMAGE ?? 'smartflow-platform:ci';
const name = process.env.SMOKE_CONTAINER ?? 'smartflow-smoke';
const port = process.env.SMOKE_PORT ?? '8790';
const email = process.env.SMOKE_EMAIL ?? 'smoke@example.test';
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

function fail(message) {
  const logs = docker(['logs', name]);
  console.error(`FAIL: ${message}`);
  const out = `${logs.stdout ?? ''}${logs.stderr ?? ''}`.trim();
  if (out) console.error(`--- container logs ---\n${out}`);
  docker(['rm', '--force', name]);
  process.exit(1);
}

function check(condition, message) {
  if (!condition) fail(message);
  console.log(`ok - ${message}`);
}

/**
 * Run a snippet inside the container and return its trimmed stdout. Fastify is
 * bound to loopback and all interfaces, so `127.0.0.1` inside is the server.
 */
function inContainer(script) {
  return docker(['exec', name, 'node', '-e', script]).stdout.trim();
}

function request(path, init = '') {
  const snippet = `fetch('http://127.0.0.1:${port}${path}'${init}).then(async (r) => { const b = await r.text(); console.log(JSON.stringify({ status: r.status, body: b })); }).catch((e) => { console.log(JSON.stringify({ status: 0, error: e.message })); })`;
  const raw = inContainer(snippet);
  try {
    return JSON.parse(raw);
  } catch {
    return { status: 0, error: raw };
  }
}

docker(['rm', '--force', name]);

const started = docker([
  'run',
  '--detach',
  '--name',
  name,
  '--env',
  `SF_OPERATOR_EMAIL=${email}`,
  image,
]);
if (started.status !== 0) {
  console.error((started.stderr ?? '').trim());
  process.exit(1);
}

/** Poll until the server answers, but stop early if the container died. */
async function waitForHealth() {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = docker(['inspect', '--format', '{{.State.Status}}', name]).stdout.trim();
    if (status === 'exited' || status === 'dead') fail(`container is ${status}`);

    const response = request('/api/v1/health');
    if (response.status === 200) return JSON.parse(response.body);
    await sleep(1_000);
  }
  fail(`health did not answer within ${timeoutMs} ms`);
}

const health = await waitForHealth();
check(health.status === 'ok', 'health reports ok');
check(typeof health.version === 'string' && health.version.length > 0, 'health reports a version');

check(
  inContainer('console.log(process.getuid())') === '1000',
  'the server process runs as uid 1000',
);

const anonymous = request('/api/v1/auth/me');
check(anonymous.status === 401, 'an anonymous session probe answers 401');

const magic = request(
  '/api/v1/auth/magic-link',
  `, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: '${email}' }) }`,
);
check(magic.status === 202, 'the magic-link route answers 202');
check(!magic.body.includes('"link"'), 'a production image never returns the sign-in link');

const unknown = request('/api/v1/nope');
check(unknown.status === 404, 'an unknown API route answers 404');
check(unknown.body.includes('not_found'), 'the 404 uses the shared error shape, not HTML');

docker(['rm', '--force', name]);
console.log('container smoke passed');
