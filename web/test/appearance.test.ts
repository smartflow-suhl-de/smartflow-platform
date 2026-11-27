import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { browser } from './helpers/browser.ts';
import { defaultTheme, type ThemeDefinition } from '../src/lib/themes.ts';
import {
  appearanceCycle,
  nextAppearance,
  themeForAppearance,
  type AppearancePair,
} from '../src/lib/appearance.ts';
import {
  AppearanceToggle,
  type AppearanceToggleProps,
} from '../src/components/AppearanceToggle.tsx';
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

  it('advances into the start of the cycle when the stored theme is unknown', () => {
    // Not a position in the cycle, so the next entry is entry 0 — light, the
    // start of the cycle, not the dark variant of the first theme.
    assert.deepEqual(nextAppearance({ themeId: 'removed-theme', mode: 'dark' }, null), {
      themeId: 'instrument',
      mode: 'light',
    });
    assert.deepEqual(nextAppearance({ themeId: 'removed-theme', mode: 'light' }, null), {
      themeId: 'instrument',
      mode: 'light',
    });
    // A custom theme that this browser no longer has behaves the same way.
    assert.deepEqual(nextAppearance({ themeId: 'custom', mode: 'dark' }, null), {
      themeId: 'instrument',
      mode: 'light',
    });
    // The unknown id has no theme to apply, so the caller keeps its own.
    assert.equal(themeForAppearance({ themeId: 'removed-theme', mode: 'dark' }, null), undefined);
    assert.equal(
      themeForAppearance({ themeId: 'instrument', mode: 'dark' }, null)?.id,
      'instrument',
    );
  });
});

/**
 * The click path as the shell wires it: the button hands its target pair to
 * `onAppearanceChange`, which resolves the theme (App.tsx) and writes both
 * values through `applyTheme`, the same writer the topbar switch uses.
 *
 * The tests below drive the real `onClick` of the rendered button instead of
 * calling `nextAppearance` themselves, so a change to the component's click
 * handling, to the pair it emits, or to the persistence keys fails here.
 */
function clickButton(
  current: AppearancePair,
  withCustom: ThemeDefinition | null,
  locale: 'de' | 'en' = 'de',
): { focused: number } {
  const messages = getMessages(locale);
  const focus = { count: 0 };

  const onChange = (next: AppearancePair): void => {
    const theme = themeForAppearance(next, withCustom);
    if (theme) applyTheme(theme, next.mode);
  };

  const element = AppearanceToggle({
    current,
    customTheme: withCustom,
    locale,
    messages,
    onChange,
  }) as ReactElement<AppearanceToggleProps & { onClick: (event: unknown) => void }>;

  element.props.onClick({
    currentTarget: {
      focus() {
        focus.count += 1;
      },
    },
  });

  return { focused: focus.count };
}

/** The pair a reload would restore, read back through the public getters. */
function restoredPair(): AppearancePair {
  return { themeId: storedTheme().id, mode: storedMode() };
}

describe('appearance persistence', () => {
  beforeEach(() => {
    browser.reset();
  });

  it('writes the clicked pair and restores it after a reload', () => {
    browser.storage.set('sf.theme', 'instrument');
    browser.storage.set('sf.mode', 'light');

    let current = restoredPair();
    const seen: string[] = [];

    for (let step = 0; step < 4; step += 1) {
      const { focused } = clickButton(current, null);
      assert.equal(focused, 1, 'the button keeps the focus after the click');

      // The click wrote through `applyTheme`, not into a second state source.
      current = restoredPair();
      seen.push(`${current.themeId}:${current.mode}`);
      assert.equal(browser.storage.get('sf.theme'), current.themeId);
      assert.equal(browser.storage.get('sf.mode'), current.mode);
      assert.equal(browser.documentElement.dataset.theme, current.themeId);
      assert.equal(browser.documentElement.dataset.mode, current.mode);
      assert.equal(browser.documentElement.classList.contains('dark'), current.mode === 'dark');
    }

    // instrument:dark → nordlicht:light → nordlicht:dark → archiv:light.
    assert.deepEqual(seen, [
      'instrument:dark',
      'nordlicht:light',
      'nordlicht:dark',
      'archiv:light',
    ]);

    // A reload starts from exactly these two keys, and the button then offers
    // the next step of the cycle from there.
    assert.deepEqual(restoredPair(), { themeId: 'archiv', mode: 'light' });
    const messages = getMessages('de');
    const html = renderToStaticMarkup(
      createElement(AppearanceToggle, {
        current: restoredPair(),
        customTheme: null,
        locale: 'de',
        messages,
        onChange: () => undefined,
      }),
    );
    assert.ok(html.includes('Darstellung: Archiv hell — wechseln zu Archiv dunkel'));
  });

  it('stores the custom theme id when the cycle reaches it', () => {
    browser.storage.set('sf.theme', 'kontrast');
    browser.storage.set('sf.mode', 'dark');

    const { themeId, mode } = nextAppearance(restoredPair(), custom);
    assert.deepEqual({ themeId, mode }, { themeId: 'custom', mode: 'light' });

    clickButton(restoredPair(), custom);
    assert.deepEqual(restoredPair(), { themeId: 'custom', mode: 'light' });
    // The custom theme travels with its own key, so a reload keeps it.
    assert.ok(browser.storage.get('sf.theme.custom'));
    assert.equal(storedTheme().label.de, 'Eigene Marke');
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
  });

  it('draws the icon of the target mode: a sun for light, a moon for dark', () => {
    const messages = getMessages('de');
    const render = (current: AppearancePair) =>
      renderToStaticMarkup(
        createElement(AppearanceToggle, {
          current,
          customTheme: null,
          locale: 'de',
          messages,
          onChange: () => undefined,
        }),
      );

    // Sun: a circle plus rays. Moon: one crescent path, no circle.
    const toLight = render({ themeId: 'instrument', mode: 'dark' });
    assert.match(toLight, /<circle cx="12" cy="12" r="4"/);
    assert.doesNotMatch(toLight, /M12 3a6 6 0 0 0 9 9/);

    const toDark = render({ themeId: 'instrument', mode: 'light' });
    assert.match(toDark, /M12 3a6 6 0 0 0 9 9/);
    assert.doesNotMatch(toDark, /<circle/);
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
