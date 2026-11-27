import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { browser, setLocation } from './helpers/browser.ts';
import { queryParamOnce } from '../src/lib/deep-link.ts';
import { useUiStore } from '../src/lib/store.ts';

/**
 * Regression for the `?q=` deep link on the discovery list.
 *
 * The helper mirrors what the page does: the URL seeds the field once, the
 * store owns the value afterwards. So the sequence "open with ?q=Muster, type
 * MusterX, clear the field" must end with an empty search, not with "Muster".
 */
describe('discovery search deep link', () => {
  beforeEach(() => {
    browser.reset();
    useUiStore.getState().resetAllFilters();
  });

  it('seeds the search field from ?q= exactly once', () => {
    setLocation('/discovery?q=Muster');

    let applied: string | null = null;
    const syncFromUrl = (search: string): void => {
      const next = queryParamOnce(search, applied);
      if (next === null) return;
      applied = next;
      useUiStore.getState().setDiscoveryFilter({ query: next });
    };

    syncFromUrl(browser.location.search);
    assert.equal(useUiStore.getState().discovery.query, 'Muster');

    // Typing changes the store, the URL keeps `?q=Muster`; nothing overwrites it.
    useUiStore.getState().setDiscoveryFilter({ query: 'MusterX' });
    syncFromUrl(browser.location.search);
    assert.equal(useUiStore.getState().discovery.query, 'MusterX');

    useUiStore.getState().setDiscoveryFilter({ query: 'MusterXY' });
    syncFromUrl(browser.location.search);
    assert.equal(useUiStore.getState().discovery.query, 'MusterXY');

    // Clearing the field must stay cleared even though the URL still has `q`.
    useUiStore.getState().setDiscoveryFilter({ query: '' });
    syncFromUrl(browser.location.search);
    assert.equal(useUiStore.getState().discovery.query, '');
  });

  it('applies a changed ?q= value again', () => {
    setLocation('/discovery?q=Angebot');

    let applied: string | null = null;
    const syncFromUrl = (search: string): void => {
      const next = queryParamOnce(search, applied);
      if (next === null) return;
      applied = next;
      useUiStore.getState().setDiscoveryFilter({ query: next });
    };

    syncFromUrl(browser.location.search);
    assert.equal(useUiStore.getState().discovery.query, 'Angebot');

    setLocation('/discovery?q=Rechnung');
    syncFromUrl(browser.location.search);
    assert.equal(useUiStore.getState().discovery.query, 'Rechnung');
  });

  it('leaves the store alone when the URL carries no query parameter', () => {
    setLocation('/discovery');
    useUiStore.getState().setDiscoveryFilter({ query: 'Acme' });

    assert.equal(queryParamOnce(browser.location.search, null), null);
    assert.equal(useUiStore.getState().discovery.query, 'Acme');
  });

  it('ignores an empty ?q=', () => {
    setLocation('/discovery?q=');
    assert.equal(queryParamOnce(browser.location.search, null), '');
  });

  it('does not throw on a malformed parameter name', () => {
    assert.equal(queryParamOnce('?%E0%A4%A=1', null), null);
  });
});
