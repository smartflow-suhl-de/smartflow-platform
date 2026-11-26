import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { addThemeColorMeta, browser } from './helpers/browser.ts';

const { applyMode, storedMode } = await import('../src/theme.ts');

describe('storedMode', () => {
  beforeEach(() => {
    browser.reset();
  });

  it('falls back to the system preference when nothing is stored', () => {
    browser.mediaQueries.set('(prefers-color-scheme: dark)', true);
    assert.equal(storedMode(), 'dark');

    browser.reset();
    browser.mediaQueries.set('(prefers-color-scheme: dark)', false);
    assert.equal(storedMode(), 'light');
  });

  it('prefers the stored value over the system preference', () => {
    browser.mediaQueries.set('(prefers-color-scheme: dark)', true);
    browser.storage.set('sf.mode', 'light');
    assert.equal(storedMode(), 'light');
  });

  it('ignores a stored value that is not a mode', () => {
    browser.storage.set('sf.mode', 'sepia');
    assert.equal(storedMode(), 'light');
  });
});

describe('applyMode', () => {
  beforeEach(() => {
    browser.reset();
  });

  it('sets the dark class, the dataset and the colour scheme', () => {
    applyMode('dark');

    assert.equal(browser.documentElement.classList.contains('dark'), true);
    assert.equal(browser.documentElement.dataset.mode, 'dark');
    assert.equal(browser.documentElement.style.colorScheme, 'dark');
  });

  it('removes the dark class when switching back to light', () => {
    applyMode('dark');
    applyMode('light');

    assert.equal(browser.documentElement.classList.contains('dark'), false);
    assert.equal(browser.documentElement.dataset.mode, 'light');
  });

  it('persists the chosen mode', () => {
    applyMode('dark');
    assert.equal(browser.storage.get('sf.mode'), 'dark');
  });

  it('mirrors the paper colour into the theme-colour meta tag', () => {
    const meta = addThemeColorMeta();
    applyMode('light');

    assert.equal(meta.getAttribute('content'), '#f2efe7');
  });

  it('does nothing when the document has no theme-colour tag', () => {
    assert.doesNotThrow(() => applyMode('dark'));
  });

  it('survives a storage that throws', () => {
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem() {
          throw new Error('denied');
        },
        setItem() {
          throw new Error('denied');
        },
      },
    });
    try {
      assert.equal(storedMode(), 'light');
      assert.doesNotThrow(() => applyMode('dark'));
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original });
    }
  });
});
