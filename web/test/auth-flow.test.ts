import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  createSubmitGuard,
  passwordProblem,
  sessionProbeOutcome,
} = await import('../src/lib/auth-flow.ts');
const { ApiError } = await import('../src/lib/api.ts');

describe('passwordProblem', () => {
  it('keeps the documented bounds in step with the API', () => {
    assert.equal(PASSWORD_MIN_LENGTH, 12);
    assert.equal(PASSWORD_MAX_LENGTH, 256);
  });

  it('accepts a password of exactly the minimum length', () => {
    assert.equal(passwordProblem('a'.repeat(PASSWORD_MIN_LENGTH)), null);
  });

  it('rejects one character below the minimum', () => {
    assert.equal(passwordProblem('a'.repeat(PASSWORD_MIN_LENGTH - 1)), 'too_short');
  });

  it('accepts a password of exactly the maximum length', () => {
    assert.equal(passwordProblem('a'.repeat(PASSWORD_MAX_LENGTH)), null);
  });

  it('rejects one character above the maximum', () => {
    assert.equal(passwordProblem('a'.repeat(PASSWORD_MAX_LENGTH + 1)), 'too_long');
  });

  it('rejects a password made only of spaces even when it is long enough', () => {
    assert.equal(passwordProblem(' '.repeat(20)), 'blank');
  });

  it('accepts spaces inside a password that also has other characters', () => {
    assert.equal(passwordProblem('correct horse battery staple'), null);
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

describe('createSubmitGuard', () => {
  it('runs one request for two submits in the same tick', async () => {
    const guard = createSubmitGuard();
    let calls = 0;
    const task = async () => {
      calls += 1;
      await Promise.resolve();
      return 'ok';
    };
    const [first, second] = await Promise.all([guard.run(task), guard.run(task)]);
    assert.equal(calls, 1);
    assert.equal(first, 'ok');
    assert.equal(second, undefined);
  });

  it('releases after success and after failure', async () => {
    const guard = createSubmitGuard();
    await assert.rejects(
      guard.run(async () => {
        throw new Error('boom');
      }),
    );
    assert.equal(guard.busy, false);
    assert.equal(await guard.run(async () => 'again'), 'again');
    assert.equal(guard.busy, false);
  });
});
