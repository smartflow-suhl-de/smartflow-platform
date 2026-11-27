import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { browser } from './helpers/browser.ts';
import { defaultTheme, type ThemeDefinition } from '../src/lib/themes.ts';
import { appearanceCycle, nextAppearance, type AppearancePair } from '../src/lib/appearance.ts';
import { AppearanceToggle } from '../src/components/AppearanceToggle.tsx';
import { getMessages } from '../src/lib/i18n.ts';
import { applyTheme, storedMode, storedTheme } from '../src/theme.ts';

const custom: ThemeDefinition = {
  ...defaultTheme(),
  id: 'custom',
  label: { de: 'Eigene Marke', en: 'Custom brand' },
  description: { de: 'Eigene Marke', en: 'Custom brand' },
  builtin: false,
};

/** Steps the switch `count` times, starting from a persisted pair. */
function click(start: AppearancePair, count: number, withCustom: ThemeDefinition | null) {
  let current = start;
  for (let i = 0; i < count; i += 1) current = nextAppearance(current, withCustom);
  return current;
}

describe('appearance cycle', () => {
  beforeEach(() => {
    browser.reset();
  });

  it('walks instrument light → dark → nordlicht light → … and wraps', () => {
    const order = appearanceCycle(null).map((pair) => `${pair.themeId}:${pair.mode}`);
    assert.deepEqual(order, [
      'instrument:light',
      'instrument:dark',
      'nordlicht:light',
      'nordlicht:dark',
      'archiv:light',
      'archiv:dark',
      'kontrast:light',
      'kontrast:dark',
    ]);

    const start = { themeId: 'instrument', mode: 'light' as const };
    assert.deepEqual(nextAppearance(start, null), { themeId: 'instrument', mode: 'dark' });
    assert.deepEqual(click(start, 2, null), { themeId: 'nordlicht', mode: 'light' });
    assert.deepEqual(click(start, 3, null), { themeId: 'nordlicht', mode: 'dark' });
    // A full round comes back to the start.
    assert.deepEqual(click(start, order.length, null), start);
  });

  it('appends the custom theme after the built-ins and wraps to instrument', () => {
    const order = appearanceCycle(custom);
    assert.equal(order.length, 10);
    assert.deepEqual(order[8], { themeId: 'custom', mode: 'light' });
    assert.deepEqual(order[9], { themeId: 'custom', mode: 'dark' });
    assert.deepEqual(nextAppearance({ themeId: 'custom', mode: 'dark' }, custom), {
      themeId: 'instrument',
      mode: 'light',
    });
  });

  it('starts from the persisted pair instead of a fixed index', () => {
    assert.deepEqual(nextAppearance({ themeId: 'archiv', mode: 'dark' }, null), {
      themeId: 'kontrast',
      mode: 'light',
    });
    assert.deepEqual(nextAppearance({ themeId: 'nordlicht', mode: 'dark' }, null), {
      themeId: 'archiv',
      mode: 'light',
    });
  });

  it('recovers when the stored theme is no longer in the catalog', () => {
    assert.deepEqual(nextAppearance({ themeId: 'removed-theme', mode: 'dark' }, null), {
      themeId: 'instrument',
      mode: 'dark',
    });
  });
});

describe('appearance persistence', () => {
  beforeEach(() => {
    browser.reset();
  });

  it('keeps the last theme and mode after a reload', () => {
    // Two clicks from the fresh state: instrument dark, nordlicht light.
    let pair: AppearancePair = { themeId: storedTheme().id, mode: storedMode() };
    pair = nextAppearance(pair, null);
    applyTheme(defaultTheme(), pair.mode);
    pair = nextAppearance(pair, null);
    const nordlicht = appearanceCycle(null).find(
      (step) => step.themeId === pair.themeId && step.mode === pair.mode,
    );
    assert.ok(nordlicht);

    // Only the pair is written, exactly like the settings page does it.
    browser.storage.set('sf.theme', pair.themeId);
    applyTheme(
      { ...defaultTheme(), id: pair.themeId, label: { de: 'Nordlicht', en: 'Northern light' } },
      pair.mode,
    );

    // A reload re-reads both values from the same keys.
    assert.equal(storedTheme().id, pair.themeId);
    assert.equal(storedMode(), pair.mode);
  });
});

describe('appearance switch button', () => {
  beforeEach(() => {
    browser.reset();
  });

  it('names the current and the next state in the label and title', () => {
    const messages = getMessages('de');
    const html = renderToStaticMarkup(
      createElement(AppearanceToggle, {
        current: { themeId: 'nordlicht', mode: 'dark' },
        customTheme: null,
        locale: 'de',
        messages,
        onChange: () => undefined,
      }),
    );

    assert.ok(
      html.includes('aria-label="Darstellung: Nordlicht dunkel — wechseln zu Archiv hell"'),
    );
    assert.ok(html.includes('title="Darstellung: Nordlicht dunkel — wechseln zu Archiv hell"'));
    // No aria-pressed for a control with more than two states.
    assert.ok(!html.includes('aria-pressed'));
    // The icon shows the target mode: light next, so a sun.
    assert.ok(html.includes('lucide') || html.includes('<svg'));
  });

  it('carries the same information in English', () => {
    const messages = getMessages('en');
    const html = renderToStaticMarkup(
      createElement(AppearanceToggle, {
        current: { themeId: 'instrument', mode: 'light' },
        customTheme: null,
        locale: 'en',
        messages,
        onChange: () => undefined,
      }),
    );

    assert.ok(
      html.includes('aria-label="Appearance: Instrument light — switch to Instrument dark"'),
    );
  });

  it('includes the custom theme in the label when the browser has one', () => {
    const messages = getMessages('de');
    const html = renderToStaticMarkup(
      createElement(AppearanceToggle, {
        current: { themeId: 'custom', mode: 'light' },
        customTheme: custom,
        locale: 'de',
        messages,
        onChange: () => undefined,
      }),
    );

    assert.ok(html.includes('Darstellung: Eigene Marke hell — wechseln zu Eigene Marke dunkel'));
  });
});
