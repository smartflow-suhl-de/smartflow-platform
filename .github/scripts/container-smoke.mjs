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
// A production image refuses to start without an https origin, so the smoke
// test supplies the minimum a real deployment would.
const publicUrl = process.env.SMOKE_PUBLIC_URL ?? 'https://smoke.example.test';
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

/** Like `request`, but keeps the response headers: the session cookie proves itself. */
function requestWithHeaders(path, init = '') {
  const snippet = `fetch('http://127.0.0.1:${port}${path}'${init}).then(async (r) => { const b = await r.text(); console.log(JSON.stringify({ status: r.status, body: b, setCookie: r.headers.get('set-cookie') })); }).catch((e) => { console.log(JSON.stringify({ status: 0, error: e.message })); })`;
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
  `SF_PUBLIC_URL=${publicUrl}`,
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

const setupState = request('/api/v1/auth/setup');
check(setupState.status === 200, 'setup state answers 200');
check(setupState.body.includes('"required":true'), 'a fresh image reports that setup is required');

const setupPassword = 'smoke-test-passphrase';
const setup = request(
  '/api/v1/auth/setup',
  `, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: '${email}', name: 'Operator', password: '${setupPassword}' }) }`,
);
check(setup.status === 201, 'the setup route creates the first operator');
check(setup.body.includes('"role":"operator"'), 'setup signs the operator in');
check(!setup.body.includes(setupPassword), 'setup never echoes the password');

const secondSetup = request(
  '/api/v1/auth/setup',
  `, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'other@example.test', name: 'Other', password: '${setupPassword}' }) }`,
);
check(secondSetup.status === 409, 'a second setup is refused');
check(secondSetup.body.includes('setup_complete'), 'the refusal uses the shared error shape');

const wrongLogin = request(
  '/api/v1/auth/login',
  `, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: '${email}', password: 'wrong-passphrase-1' }) }`,
);
check(wrongLogin.status === 401, 'a wrong password is refused');
check(wrongLogin.body.includes('invalid_credentials'), 'the refusal names the stable error code');

const login = requestWithHeaders(
  '/api/v1/auth/login',
  `, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: '${email}', password: '${setupPassword}' }) }`,
);
check(login.status === 200, 'the right password signs in');
check(login.body.includes('"email"'), 'login answers with the signed-in user');
const cookie = login.setCookie ?? '';
check(/^sf_session=/.test(cookie), 'login sets the session cookie');
check(/HttpOnly/i.test(cookie), 'the session cookie is HttpOnly');
check(/Secure/i.test(cookie), 'the production cookie is Secure');
check(!login.body.includes(setupPassword), 'login never echoes the password');

const unknown = request('/api/v1/nope');
check(unknown.status === 404, 'an unknown API route answers 404');
check(unknown.body.includes('not_found'), 'the 404 uses the shared error shape, not HTML');

// The image ships the built SPA and serves it from the same process. Without
// these probes a regression that drops the web build still looks healthy: the
// API keeps answering while `/` is a 404 for every browser.
const root = request('/', `, { headers: { accept: 'text/html' } }`);
check(root.status === 200, 'the SPA root answers 200');
check(root.body.includes('<div id="root"'), 'the SPA root is the built index, not JSON');

const deepLink = request('/tenants', `, { headers: { accept: 'text/html' } }`);
check(deepLink.status === 200, 'a deep link answers 200');
check(deepLink.body.includes('<div id="root"'), 'a deep link is the SPA shell, not a 404');

const apiAsBrowser = request('/api/v1/nope', `, { headers: { accept: 'text/html' } }`);
check(apiAsBrowser.status === 404, 'an unknown API route is not masked by the SPA fallback');
check(apiAsBrowser.body.includes('not_found'), 'the API 404 keeps its JSON shape');

docker(['rm', '--force', name]);
console.log('container smoke passed');
