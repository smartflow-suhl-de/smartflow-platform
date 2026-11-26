import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { browser, setLocation } from './helpers/browser.ts';

const { navigate } = await import('../src/lib/router.ts');

describe('router.navigate', () => {
  beforeEach(() => {
    browser.reset();
    setLocation('/');
  });

  it('pushes a new entry for a different path', () => {
    navigate('/tenants');

    assert.equal(browser.location.pathname, '/tenants');
    assert.equal(browser.location.pushStateCalls.length, 1);
    assert.equal(browser.location.replaceStateCalls.length, 0);
  });

  it('replaces instead of pushing when asked', () => {
    navigate('/login', { replace: true });

    assert.equal(browser.location.pathname, '/login');
    assert.equal(browser.location.replaceStateCalls.length, 1);
    assert.equal(browser.location.pushStateCalls.length, 0);
  });

  it('does not duplicate history for the current location', () => {
    navigate('/help');
    navigate('/help');

    assert.equal(browser.location.pushStateCalls.length, 1);
  });

  it('keeps the query string', () => {
    navigate('/tenants?create=1');

    assert.equal(browser.location.pathname, '/tenants');
    assert.equal(browser.location.search, '?create=1');
  });

  it('treats the same path with a different query as a navigation', () => {
    setLocation('/tenants');
    navigate('/tenants?create=1');

    assert.equal(browser.location.pushStateCalls.length, 1);
    assert.equal(browser.location.search, '?create=1');
  });

  it('resolves relative targets against the origin', () => {
    setLocation('/tenants');
    navigate('?create=1');

    assert.equal(browser.location.pathname, '/tenants');
    assert.equal(browser.location.search, '?create=1');
  });

  it('normalises a target without a leading slash', () => {
    navigate('help');

    assert.equal(browser.location.pathname, '/help');
  });

  it('drops the hash from the location it stores', () => {
    navigate('/help#top');

    assert.equal(browser.location.pathname, '/help');
    assert.equal(browser.location.search, '');
  });
});

describe('router subscription', () => {
  beforeEach(() => {
    browser.reset();
    setLocation('/');
  });

  it('notifies listeners registered through subscribeToLocation', async () => {
    const { navigate, subscribeToLocation } = await import('../src/lib/router.ts');
    let calls = 0;
    const unsubscribe = subscribeToLocation(() => {
      calls += 1;
    });

    navigate('/tenants');
    assert.equal(calls, 1);

    unsubscribe();
    navigate('/help');
    assert.equal(calls, 1);
  });

  it('listens for popstate only while subscribed', async () => {
    const { subscribeToLocation } = await import('../src/lib/router.ts');
    assert.equal(browser.eventTypes().includes('popstate'), false);

    const unsubscribe = subscribeToLocation(() => undefined);
    assert.equal(browser.eventTypes().includes('popstate'), true);

    unsubscribe();
    assert.equal(browser.eventTypes().includes('popstate'), false);
  });
});

describe('isPlainLeftClick', () => {
  const plain = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
  };

  it('accepts an unmodified left click', async () => {
    const { isPlainLeftClick } = await import('../src/lib/router.ts');
    assert.equal(isPlainLeftClick(plain), true);
  });

  it('rejects modified and non-left clicks', async () => {
    const { isPlainLeftClick } = await import('../src/lib/router.ts');
    for (const patch of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
      { defaultPrevented: true },
    ]) {
      assert.equal(isPlainLeftClick({ ...plain, ...patch }), false, JSON.stringify(patch));
    }
  });
});
