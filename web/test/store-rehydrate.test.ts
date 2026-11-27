import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { browser } from './helpers/browser.ts';
import { clearMemoryFallback, sanitizePersistedState, useUiStore } from '../src/lib/store.ts';
import { applyTheme } from '../src/theme.ts';
import { defaultTheme, type ThemeDefinition } from '../src/lib/themes.ts';

/** Writes a raw `sf.ui-state` payload the way the persist middleware does. */
function storePayload(state: unknown, version = 1): void {
  browser.storage.set('sf.ui-state', JSON.stringify({ state, version }));
}

const brokenThemeShapes: Array<[string, unknown]> = [
  ['theme without tokens', { id: 'evil' }],
  ['theme with a null light palette', { id: 'evil', light: null, dark: null }],
  ['theme with an incomplete palette', { id: 'evil', light: { paper: '#ffffff' }, dark: {} }],
  ['theme that is not an object', 'evil'],
  ['theme id without a string', { ...defaultTheme(), id: 42 }],
];

describe('store rehydration hardening', () => {
  beforeEach(async () => {
    browser.reset();
    clearMemoryFallback();
    // Reset the in-memory store too: a previous test may have left a theme or a
    // filter behind, and rehydration merges over the current state.
    useUiStore.setState({
      tenants: { statusFilter: 'all', query: '' },
      websites: { filter: 'all', query: '' },
      discovery: { statusFilter: 'all', query: '' },
      preferences: {
        mode: 'light',
        theme: defaultTheme(),
        customTheme: null,
        locale: 'de',
      },
    });
    browser.reset();
    clearMemoryFallback();
    await useUiStore.persist.rehydrate();
  });

  for (const [label, badTheme] of brokenThemeShapes) {
    it(`falls back to the default theme for a ${label}`, async () => {
      storePayload({
        tenants: { statusFilter: 'all', query: '' },
        websites: { filter: 'all', query: '' },
        discovery: { statusFilter: 'all', query: '' },
        preferences: { mode: 'light', theme: badTheme, customTheme: null, locale: 'de' },
      });

      await useUiStore.persist.rehydrate();

      const theme = useUiStore.getState().preferences.theme;
      assert.equal(theme.id, defaultTheme().id);
      assert.doesNotThrow(() => applyTheme(theme, 'light'));
    });
  }

  it('keeps a structurally complete persisted theme', async () => {
    const custom: ThemeDefinition = {
      ...defaultTheme(),
      id: 'custom',
      label: { de: 'Eigene Marke', en: 'Custom brand' },
      builtin: false,
    };
    storePayload({
      tenants: { statusFilter: 'all', query: '' },
      websites: { filter: 'all', query: '' },
      discovery: { statusFilter: 'all', query: '' },
      preferences: { mode: 'dark', theme: custom, customTheme: custom, locale: 'en' },
    });

    await useUiStore.persist.rehydrate();

    const prefs = useUiStore.getState().preferences;
    assert.equal(prefs.theme.id, 'custom');
    assert.equal(prefs.customTheme?.id, 'custom');
    assert.equal(prefs.mode, 'dark');
    assert.equal(prefs.locale, 'en');
    assert.doesNotThrow(() => applyTheme(prefs.theme, prefs.mode));
  });

  it('refuses a broken custom theme but keeps the built-in active theme', async () => {
    const nordlicht = { id: 'nordlicht' };
    storePayload({
      tenants: { statusFilter: 'all', query: '' },
      websites: { filter: 'all', query: '' },
      discovery: { statusFilter: 'all', query: '' },
      preferences: {
        mode: 'light',
        theme: nordlicht,
        customTheme: { id: 'custom' },
        locale: 'de',
      },
    });

    await useUiStore.persist.rehydrate();

    const prefs = useUiStore.getState().preferences;
    assert.equal(prefs.theme.id, 'nordlicht');
    assert.equal(prefs.customTheme, null);
    assert.doesNotThrow(() => applyTheme(prefs.theme, prefs.mode));
  });

  it('ignores unknown filter values instead of crashing on them', async () => {
    storePayload({
      tenants: { statusFilter: 'nonsense', query: 7 },
      websites: { filter: {}, query: null },
      discovery: { statusFilter: 3, query: [] },
      preferences: { mode: 'sepia', theme: defaultTheme(), customTheme: null, locale: 'fr' },
    });

    await useUiStore.persist.rehydrate();

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

  it('survives a payload that is not an object', async () => {
    browser.storage.set('sf.ui-state', 'null');

    await useUiStore.persist.rehydrate();

    assert.equal(useUiStore.getState().preferences.theme.id, defaultTheme().id);
  });

  it('sanitizes without touching the DOM or storage', () => {
    const themeBefore = browser.storage.get('sf.theme');

    const state = sanitizePersistedState({
      discovery: { statusFilter: 'completed', query: 'Muster' },
      preferences: { theme: { id: 'evil' } },
    });

    assert.equal(state.discovery.statusFilter, 'completed');
    assert.equal(state.discovery.query, 'Muster');
    assert.equal(state.preferences.theme.id, defaultTheme().id);
    assert.equal(browser.storage.get('sf.theme'), themeBefore);
  });

  it('rejects a token value that is not a hex colour', async () => {
    const evil = {
      ...defaultTheme(),
      id: 'custom',
      light: { ...defaultTheme().light, paper: 'url(https://evil.example/t.gif)' },
    };
    storePayload({
      tenants: { statusFilter: 'all', query: '' },
      websites: { filter: 'all', query: '' },
      discovery: { statusFilter: 'all', query: '' },
      preferences: { mode: 'light', theme: evil, customTheme: evil, locale: 'de' },
    });

    await useUiStore.persist.rehydrate();

    const prefs = useUiStore.getState().preferences;
    assert.equal(prefs.theme.id, defaultTheme().id);
    assert.equal(prefs.customTheme, null);

    assert.doesNotThrow(() => applyTheme(prefs.theme, 'light'));
    const written = browser.documentElement.style.getPropertyValue('--color-paper');
    assert.equal(written, defaultTheme().light.paper);
    assert.ok(!written.includes('url('));
  });

  it('falls back to the default for a search text that is not a string', async () => {
    storePayload({
      tenants: { statusFilter: 'all', query: { evil: true } },
      websites: { filter: 'all', query: { evil: true } },
      discovery: { statusFilter: 'all', query: { evil: true } },
      preferences: { mode: 'light', theme: defaultTheme(), customTheme: null, locale: 'de' },
    });

    await useUiStore.persist.rehydrate();

    const state = useUiStore.getState();
    assert.equal(state.tenants.query, '');
    assert.equal(state.websites.query, '');
    assert.equal(state.discovery.query, '');
    // The pages call `query.trim()` on these values, so a string is required.
    assert.doesNotThrow(() => state.tenants.query.trim());
    assert.doesNotThrow(() => state.websites.query.trim());
    assert.doesNotThrow(() => state.discovery.query.trim());
  });

  it('drops over-long search texts instead of persisting them', async () => {
    storePayload({
      tenants: { statusFilter: 'all', query: 'x'.repeat(5000) },
      websites: { filter: 'all', query: '' },
      discovery: { statusFilter: 'all', query: 'y'.repeat(5000) },
      preferences: { mode: 'light', theme: defaultTheme(), customTheme: null, locale: 'de' },
    });

    await useUiStore.persist.rehydrate();

    const state = useUiStore.getState();
    assert.equal(state.tenants.query.length, 200);
    assert.equal(state.discovery.query.length, 200);
  });
});
