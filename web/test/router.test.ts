import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { ReactElement } from 'react';
import { browser, setLocation } from './helpers/browser.ts';

const { AppLink, navigate, normalizePath } = await import('../src/lib/router.ts');

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

  it('scrolls to the top for a new history entry', () => {
    navigate('/tenants');

    assert.deepEqual(browser.scrollCalls, [{ x: 0, y: 0 }]);
  });

  it('keeps the scroll position on a replace', () => {
    // `replace` is the shape used for redirects (`/mandanten` → `/tenants`) and
    // for `/tenants?create=1`, where jumping to the top would lose the context
    // the user just came from.
    navigate('/tenants', { replace: true });

    assert.deepEqual(browser.scrollCalls, []);
  });

  it('does not scroll when the navigation is a no-op', () => {
    setLocation('/tenants');
    navigate('/tenants');

    assert.deepEqual(browser.scrollCalls, []);
  });

  it('treats the same path with a different query as a navigation', () => {
    setLocation('/tenants');
    navigate('/tenants?create=1');

    assert.equal(browser.location.pushStateCalls.length, 1);
    assert.equal(browser.location.search, '?create=1');
  });

  it('resolves relative targets against the current document', () => {
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

describe('normalizePath', () => {
  it('drops a trailing slash', () => {
    assert.equal(normalizePath('/tenants/'), '/tenants');
    assert.equal(normalizePath('/tenants//'), '/tenants');
  });

  it('collapses repeated slashes inside the path', () => {
    assert.equal(normalizePath('/a//b'), '/a/b');
    assert.equal(normalizePath('/a///b//c'), '/a/b/c');
  });

  it('keeps the root and the bare slash', () => {
    assert.equal(normalizePath('/'), '/');
    assert.equal(normalizePath('///'), '/');
    assert.equal(normalizePath(''), '/');
  });

  it('leaves an already canonical path untouched', () => {
    assert.equal(normalizePath('/tenants'), '/tenants');
    assert.equal(normalizePath('/login/confirm'), '/login/confirm');
    assert.equal(normalizePath('/Tenants'), '/Tenants');
  });
});

describe('AppLink', () => {
  // The setup has no renderer, so the component is called directly and the
  // click handler is taken off the element it returns. `AppLink` uses no hooks,
  // which is what makes this safe.
  function clickHandlerFor(props: Parameters<typeof AppLink>[0]) {
    const element = AppLink(props) as unknown as ReactElement<{
      onClick: (event: unknown) => void;
    }>;
    return element.props.onClick;
  }

  function fakeClickEvent() {
    const event = {
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      defaultPrevented: false,
      preventDefault() {
        event.defaultPrevented = true;
      },
    };
    return event;
  }

  beforeEach(() => {
    browser.reset();
    setLocation('/');
  });

  it('navigates on an unmodified click without target or download', () => {
    const event = fakeClickEvent();
    clickHandlerFor({ to: '/tenants' })(event);

    assert.equal(event.defaultPrevented, true);
    assert.equal(browser.location.pathname, '/tenants');
    assert.equal(browser.location.pushStateCalls.length, 1);
  });

  it('leaves a click with a target to the browser', () => {
    const event = fakeClickEvent();
    clickHandlerFor({ to: '/tenants', target: '_blank' })(event);

    assert.equal(event.defaultPrevented, false);
    assert.equal(browser.location.pathname, '/');
    assert.equal(browser.location.pushStateCalls.length, 0);
  });

  it('leaves a download click to the browser', () => {
    const event = fakeClickEvent();
    clickHandlerFor({ to: '/tenants.csv', download: 'tenants.csv' })(event);

    assert.equal(event.defaultPrevented, false);
    assert.equal(browser.location.pathname, '/');
    assert.equal(browser.location.pushStateCalls.length, 0);
  });

  it('lets the caller cancel the navigation in its own onClick', () => {
    let callerRan = false;
    const handler = clickHandlerFor({
      to: '/tenants',
      onClick: (event) => {
        callerRan = true;
        event.preventDefault();
      },
    });

    const event = fakeClickEvent();
    handler(event);

    assert.equal(callerRan, true);
    assert.equal(event.defaultPrevented, true);
    assert.equal(browser.location.pushStateCalls.length, 0);
  });
});
