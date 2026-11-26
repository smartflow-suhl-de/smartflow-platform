import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, it } from 'node:test';
import type { ThemeFileError, ThemeTokens, TokenKey } from '../src/lib/themes.ts';
import { addThemeColorMeta, browser } from './helpers/browser.ts';

const color = await import('../src/lib/theme-color.ts');
const themes = await import('../src/lib/themes.ts');
const theme = await import('../src/theme.ts');

const CSS_VARS: Record<string, string> = {
  paper: '--color-paper',
  paperRaised: '--color-paper-raised',
  surface: '--color-surface',
  ink: '--color-ink',
  inkSoft: '--color-ink-soft',
  inkMuted: '--color-ink-muted',
  line: '--color-line',
  lineStrong: '--color-line-strong',
  cobalt: '--color-cobalt',
  cobaltDeep: '--color-cobalt-deep',
  signal: '--color-signal',
  good: '--color-good',
  warn: '--color-warn',
  bad: '--color-bad',
};

const SAMPLE = {
  name: 'Ozean',
  accent: '#0f766e',
  paper: '#f1f5f2',
};

describe('theme colour helpers', () => {
  it('computes WCAG contrast ratios symmetrically', () => {
    assert.ok(color.contrastRatio('#000000', '#ffffff') > 20.9);
    assert.equal(
      color.contrastRatio('#1e3bff', '#f2efe7').toFixed(2),
      color.contrastRatio('#f2efe7', '#1e3bff').toFixed(2),
    );
  });

  it('parses and normalises shorthand hex', () => {
    assert.deepEqual(color.parseHex('#abc'), { r: 170, g: 187, b: 204 });
    assert.equal(color.normalizeHex('#ABC'), '#aabbcc');
    assert.equal(color.parseHex('red'), null);
    assert.equal(color.parseHex('#12345'), null);
    assert.equal(color.isHexColor('#FFF; background: url(x)'), false);
  });

  it('mixes towards the requested endpoint', () => {
    assert.equal(color.mix('#000000', '#ffffff', 0), '#000000');
    assert.equal(color.mix('#000000', '#ffffff', 1), '#ffffff');
    assert.equal(color.mix('#000000', '#ffffff', 0.5), '#808080');
  });

  it('moves a colour only as far as the target contrast needs', () => {
    const lifted = color.ensureContrast('#888888', '#ffffff', 7);
    assert.ok(color.contrastRatio(lifted, '#ffffff') >= 7);
    assert.ok(color.relativeLuminance(lifted) < color.relativeLuminance('#888888'));

    const alreadyPassing = color.ensureContrast('#12161a', '#f2efe7', 7);
    assert.equal(alreadyPassing, '#12161a');
  });
});

describe('theme catalog', () => {
  it('ships the four built-in themes with unique ids', () => {
    const ids = themes.BUILTIN_THEMES.map((entry) => entry.id);
    assert.deepEqual(ids, ['instrument', 'nordlicht', 'archiv', 'kontrast']);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(themes.findTheme(themes.DEFAULT_THEME_ID));
  });

  it('keeps every built-in theme readable in both modes', () => {
    for (const entry of themes.BUILTIN_THEMES) {
      assert.deepEqual(themes.contrastProblems(entry), [], entry.id);
    }
  });

  it('stores only normalised hex values', () => {
    for (const entry of themes.BUILTIN_THEMES) {
      for (const mode of ['light', 'dark'] as const) {
        for (const key of themes.TOKEN_KEYS) {
          const value = entry[mode][key];
          assert.equal(color.isHexColor(value), true, `${entry.id} ${mode} ${key}`);
          assert.equal(value, value.toLowerCase());
        }
      }
    }
  });

  it('labels every built-in theme in German and English', () => {
    for (const entry of themes.BUILTIN_THEMES) {
      assert.ok(themes.themeLabel(entry, 'de').length > 0);
      assert.ok(themes.themeLabel(entry, 'en').length > 0);
      assert.ok(themes.themeDescription(entry, 'de').length > 0);
      assert.ok(themes.themeDescription(entry, 'en').length > 0);
    }
  });

  it('keeps the CSS defaults in step with the default theme', () => {
    const css = readFileSync(fileURLToPath(new URL('../src/index.css', import.meta.url)), 'utf8');
    const root = css.match(/:root\s*\{([\s\S]*?)\n\}/);
    const dark = css.match(/\.dark\s*\{([\s\S]*?)\n\}/);
    assert.ok(root && dark, 'index.css keeps :root and .dark token blocks');

    const instrument = themes.defaultTheme();
    for (const [key, variable] of Object.entries(CSS_VARS)) {
      const lightValue: RegExpMatchArray | null = root[1].match(
        new RegExp(`${variable}:\\s*(#[0-9a-fA-F]{6})`),
      );
      const darkValue: RegExpMatchArray | null = dark[1].match(
        new RegExp(`${variable}:\\s*(#[0-9a-fA-F]{6})`),
      );
      assert.ok(lightValue, `:root defines ${variable}`);
      assert.ok(darkValue, `.dark defines ${variable}`);
      assert.equal(
        lightValue[1].toLowerCase(),
        instrument.light[key as TokenKey],
        `${variable} light`,
      );
      assert.equal(
        darkValue[1].toLowerCase(),
        instrument.dark[key as TokenKey],
        `${variable} dark`,
      );
    }
  });
});

describe('custom theme derivation', () => {
  it('derives readable tokens for arbitrary accents', () => {
    for (const accent of ['#0f766e', '#1e3bff', '#c2410c', '#6d28d9', '#000000', '#eab308']) {
      const built = themes.buildCustomTheme({ ...SAMPLE, accent });
      assert.deepEqual(themes.contrastProblems(built), [], accent);
      assert.equal(built.id, 'custom');
      assert.equal(built.builtin, false);
    }
  });

  it('keeps a dark mode derived from the chosen paper', () => {
    const built = themes.buildCustomTheme(SAMPLE);
    assert.ok(color.relativeLuminance(built.light.paper) > 0.8);
    assert.ok(color.relativeLuminance(built.dark.paper) < 0.05);
  });

  it('rejects a dark paper colour and an empty name', () => {
    assert.deepEqual(themes.customThemeProblems({ ...SAMPLE, paper: '#101010' }), [
      'paper_too_dark',
    ]);
    assert.deepEqual(themes.customThemeProblems({ ...SAMPLE, name: '   ' }), ['name']);
    assert.deepEqual(themes.customThemeProblems({ ...SAMPLE, accent: 'red' }), ['accent']);
    assert.throws(() => themes.buildCustomTheme({ ...SAMPLE, paper: '#101010' }));
  });

  it('caps the theme name at forty characters', () => {
    assert.equal(themes.isValidThemeName('a'.repeat(40)), true);
    assert.equal(themes.isValidThemeName('a'.repeat(41)), false);
    assert.equal(themes.isValidThemeName('Zeile\numbruch'), false);
  });
});

describe('theme file', () => {
  it('round-trips an exported theme', () => {
    const built = themes.buildCustomTheme(SAMPLE);
    const parsed = themes.parseThemeFile(themes.serializeTheme(built));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.theme.label.de, 'Ozean');
    assert.deepEqual(parsed.theme.light, built.light);
    assert.deepEqual(parsed.theme.dark, built.dark);
  });

  it('accepts the compact name, accent, paper form', () => {
    const parsed = themes.parseThemeFile(JSON.stringify({ ...SAMPLE, name: 'Moor' }));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(themes.contrastProblems(parsed.theme), []);
  });

  it('rejects malformed files with a named error', () => {
    const cases: Array<[string, ThemeFileError]> = [
      ['{', 'invalid_json'],
      ['[]', 'invalid_shape'],
      [
        JSON.stringify({ schemaVersion: 2, name: 'X', accent: '#123456', paper: '#ffffff' }),
        'invalid_version',
      ],
      [
        JSON.stringify({ name: 'X', accent: '#123456', paper: '#ffffff', extra: true }),
        'invalid_shape',
      ],
      [JSON.stringify({ name: '', accent: '#123456', paper: '#ffffff' }), 'invalid_name'],
      [JSON.stringify({ name: 'X', accent: '#fff;--x:1', paper: '#ffffff' }), 'invalid_color'],
      [JSON.stringify({ name: 'X', accent: '#123456', paper: '#101010' }), 'paper_too_dark'],
    ];
    for (const [input, expected] of cases) {
      const parsed = themes.parseThemeFile(input);
      assert.equal(parsed.ok, false, input);
      if (parsed.ok) continue;
      assert.equal(parsed.error, expected, input);
    }
  });

  it('refuses full token sets that fail the contrast rules', () => {
    const built = themes.buildCustomTheme(SAMPLE);
    const broken = JSON.parse(themes.serializeTheme(built)) as {
      name: string;
      light: ThemeTokens;
      dark: ThemeTokens;
    };
    broken.light.ink = broken.light.paper;
    const parsed = themes.parseThemeFile(JSON.stringify(broken));
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.equal(parsed.error, 'low_contrast');
  });

  it('rejects token sets with missing or unknown keys', () => {
    const built = themes.buildCustomTheme(SAMPLE);
    const broken = JSON.parse(themes.serializeTheme(built)) as Record<string, unknown>;
    const light = { ...(broken.light as Record<string, string>) };
    delete light.ink;
    light.extra = '#ffffff';
    const parsed = themes.parseThemeFile(JSON.stringify({ ...broken, light, dark: broken.dark }));
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.equal(parsed.error, 'invalid_color');
  });
});

describe('theme storage and application', () => {
  beforeEach(() => {
    browser.reset();
  });

  it('falls back to the default theme when nothing is stored', () => {
    assert.equal(theme.storedTheme().id, 'instrument');
    assert.equal(theme.storedCustomTheme(), null);
  });

  it('applies a built-in theme and persists it', () => {
    const nordlicht = themes.findTheme('nordlicht');
    assert.ok(nordlicht);
    theme.applyTheme(nordlicht, 'dark');

    assert.equal(browser.documentElement.dataset.theme, 'nordlicht');
    assert.equal(browser.documentElement.classList.contains('dark'), true);
    assert.equal(
      browser.documentElement.style.getPropertyValue('--color-paper'),
      nordlicht.dark.paper,
    );
    assert.equal(browser.storage.get('sf.theme'), 'nordlicht');
    assert.equal(theme.storedTheme().id, 'nordlicht');
  });

  it('round-trips a custom theme through storage', () => {
    const custom = themes.buildCustomTheme(SAMPLE);
    theme.applyTheme(custom, 'light');

    assert.equal(browser.documentElement.dataset.theme, 'custom');
    assert.equal(
      browser.documentElement.style.getPropertyValue('--color-paper'),
      custom.light.paper,
    );
    assert.deepEqual(theme.storedCustomTheme()?.light, custom.light);
    assert.deepEqual(theme.storedTheme().dark, custom.dark);
  });

  it('mirrors the theme paper colour into the meta tag', () => {
    const meta = addThemeColorMeta();
    const archiv = themes.findTheme('archiv');
    assert.ok(archiv);
    theme.applyTheme(archiv, 'light');
    assert.equal(meta.getAttribute('content'), archiv.light.paper);
  });

  it('ignores a stored theme id it does not know', () => {
    browser.storage.set('sf.theme', 'neon');
    assert.equal(theme.storedTheme().id, 'instrument');
  });

  it('ignores a stored custom theme that no longer validates', () => {
    browser.storage.set('sf.theme', 'custom');
    browser.storage.set('sf.theme.custom', '{"name":"kaputt"}');
    assert.equal(theme.storedCustomTheme(), null);
    assert.equal(theme.storedTheme().id, 'instrument');
  });

  it('clears the custom theme and returns to the default', () => {
    const custom = themes.buildCustomTheme(SAMPLE);
    theme.applyTheme(custom, 'light');
    theme.clearCustomTheme();

    assert.equal(browser.storage.has('sf.theme.custom'), false);
    assert.equal(theme.storedCustomTheme(), null);
    assert.equal(theme.storedTheme().id, 'instrument');
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
        removeItem() {
          throw new Error('denied');
        },
      },
    });
    try {
      assert.equal(theme.storedTheme().id, 'instrument');
      assert.equal(theme.storedCustomTheme(), null);
      assert.doesNotThrow(() => theme.applyTheme(themes.defaultTheme(), 'dark'));
      assert.doesNotThrow(() => theme.clearCustomTheme());
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original });
    }
  });
});
