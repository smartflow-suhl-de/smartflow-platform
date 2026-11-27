import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { browser } from './helpers/browser.ts';
import { clearMemoryFallback, safeLocalStorage, useUiStore } from '../src/lib/store.ts';
import { BUILTIN_THEMES, defaultTheme } from '../src/lib/themes.ts';

describe('UI Store & Persistence', () => {
  beforeEach(() => {
    browser.reset();
    clearMemoryFallback();
    useUiStore.getState().resetAllFilters();
  });

  it('initializes with default filters and system/stored preferences', () => {
    const state = useUiStore.getState();

    assert.equal(state.tenants.statusFilter, 'all');
    assert.equal(state.tenants.query, '');

    assert.equal(state.websites.filter, 'all');
    assert.equal(state.websites.query, '');

    assert.equal(state.discovery.statusFilter, 'all');
    assert.equal(state.discovery.query, '');

    assert.ok(state.preferences.mode === 'light' || state.preferences.mode === 'dark');
    assert.equal(state.preferences.locale, 'de');
  });

  it('updates and resets tenant filters', () => {
    useUiStore.getState().setTenantFilter({ statusFilter: 'active', query: 'Acme' });

    let state = useUiStore.getState();
    assert.equal(state.tenants.statusFilter, 'active');
    assert.equal(state.tenants.query, 'Acme');

    useUiStore.getState().resetTenantFilter();
    state = useUiStore.getState();
    assert.equal(state.tenants.statusFilter, 'all');
    assert.equal(state.tenants.query, '');
  });

  it('updates and resets website filters', () => {
    useUiStore.getState().setWebsiteFilter({ filter: 'client', query: 'portal' });

    let state = useUiStore.getState();
    assert.equal(state.websites.filter, 'client');
    assert.equal(state.websites.query, 'portal');

    useUiStore.getState().resetWebsiteFilter();
    state = useUiStore.getState();
    assert.equal(state.websites.filter, 'all');
    assert.equal(state.websites.query, '');
  });

  it('updates and resets discovery filters', () => {
    useUiStore.getState().setDiscoveryFilter({ statusFilter: 'in_progress', query: 'Muster' });

    let state = useUiStore.getState();
    assert.equal(state.discovery.statusFilter, 'in_progress');
    assert.equal(state.discovery.query, 'Muster');

    useUiStore.getState().resetDiscoveryFilter();
    state = useUiStore.getState();
    assert.equal(state.discovery.statusFilter, 'all');
    assert.equal(state.discovery.query, '');
  });

  it('updates mode and synchronizes with sf.mode storage', () => {
    useUiStore.getState().setMode('dark');
    assert.equal(useUiStore.getState().preferences.mode, 'dark');
    assert.equal(browser.storage.get('sf.mode'), 'dark');

    useUiStore.getState().setMode('light');
    assert.equal(useUiStore.getState().preferences.mode, 'light');
    assert.equal(browser.storage.get('sf.mode'), 'light');
  });

  it('updates theme and synchronizes with sf.theme storage', () => {
    const nordlichtTheme = BUILTIN_THEMES.find((t) => t.id === 'nordlicht') ?? defaultTheme();
    useUiStore.getState().setTheme(nordlichtTheme);

    assert.equal(useUiStore.getState().preferences.theme.id, 'nordlicht');
    assert.equal(browser.storage.get('sf.theme'), 'nordlicht');
  });

  it('updates custom theme and supports removal', () => {
    const base = defaultTheme();
    const custom = {
      ...base,
      id: 'custom',
      label: { de: 'Eigene Marke', en: 'Custom Brand' },
      builtin: false,
    };
    useUiStore.getState().setCustomTheme(custom);
    assert.equal(useUiStore.getState().preferences.theme.id, 'custom');
    assert.equal(useUiStore.getState().preferences.customTheme?.label.en, 'Custom Brand');

    useUiStore.getState().removeCustomTheme();
    assert.equal(useUiStore.getState().preferences.customTheme, null);
    assert.equal(useUiStore.getState().preferences.theme.id, defaultTheme().id);
  });

  it('updates locale and synchronizes with sf.locale storage', () => {
    useUiStore.getState().setLocale('en');
    assert.equal(useUiStore.getState().preferences.locale, 'en');
    assert.equal(browser.storage.get('sf.locale'), 'en');

    useUiStore.getState().setLocale('de');
    assert.equal(useUiStore.getState().preferences.locale, 'de');
    assert.equal(browser.storage.get('sf.locale'), 'de');
  });

  it('persists only non-sensitive state and no methods via partialize', () => {
    useUiStore.getState().setTenantFilter({ statusFilter: 'suspended', query: 'secret-filter' });

    const raw = browser.storage.get('sf.ui-state');
    assert.ok(raw, 'persisted key sf.ui-state should exist in storage');

    const parsed = JSON.parse(raw);
    assert.equal(parsed.version, 1);
    assert.ok(parsed.state, 'persisted payload should contain state');

    // Filter fields exist
    assert.equal(parsed.state.tenants.statusFilter, 'suspended');
    assert.equal(parsed.state.tenants.query, 'secret-filter');
    assert.ok(parsed.state.websites);
    assert.ok(parsed.state.discovery);
    assert.ok(parsed.state.preferences);

    // No action functions or secret fields leaked
    assert.equal(parsed.state.setTenantFilter, undefined);
    assert.equal(parsed.state.resetAllFilters, undefined);
    assert.equal(parsed.state.password, undefined);
    assert.equal(parsed.state.token, undefined);
  });

  it('survives private browsing / quota errors with in-memory fallback', () => {
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem() {
          throw new Error('QuotaExceeded or AccessDenied');
        },
        setItem() {
          throw new Error('QuotaExceeded or AccessDenied');
        },
        removeItem() {
          throw new Error('AccessDenied');
        },
      },
    });

    try {
      assert.doesNotThrow(() => {
        safeLocalStorage.setItem('test-key', 'test-value');
      });
      assert.equal(safeLocalStorage.getItem('test-key'), 'test-value');
      assert.doesNotThrow(() => {
        safeLocalStorage.removeItem('test-key');
      });
      assert.equal(safeLocalStorage.getItem('test-key'), null);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original });
    }
  });
});
