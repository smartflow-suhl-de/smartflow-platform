import {
  CUSTOM_THEME_ID,
  DEFAULT_THEME_ID,
  TOKEN_KEYS,
  defaultTheme,
  findTheme,
  parseThemeFile,
  serializeTheme,
  type Mode,
  type ThemeDefinition,
  type ThemeTokens,
} from './lib/themes';

export type { Mode } from './lib/themes';

const MODE_KEY = 'sf.mode';
const THEME_KEY = 'sf.theme';
const CUSTOM_KEY = 'sf.theme.custom';

const TOKEN_VARS: Record<keyof ThemeTokens, string> = {
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

function readItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* privater Modus oder Speicher voll */
  }
}

function removeItem(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* privater Modus */
  }
}

export function storedMode(): Mode {
  const value = readItem(MODE_KEY);
  if (value === 'light' || value === 'dark') return value;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyMode(mode: Mode): void {
  const root = document.documentElement;
  root.classList.toggle('dark', mode === 'dark');
  root.dataset.mode = mode;
  root.style.colorScheme = mode;
  const paper = getComputedStyle(root).getPropertyValue('--color-paper').trim();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (paper && meta) meta.setAttribute('content', paper);
  writeItem(MODE_KEY, mode);
}

/** The custom theme stored in this browser, or `null` when it is unreadable. */
export function storedCustomTheme(): ThemeDefinition | null {
  const raw = readItem(CUSTOM_KEY);
  if (!raw) return null;
  const parsed = parseThemeFile(raw);
  return parsed.ok ? parsed.theme : null;
}

/** Active theme: the stored custom theme, a built-in id, or the default. */
export function storedTheme(): ThemeDefinition {
  const id = readItem(THEME_KEY);
  if (id === CUSTOM_THEME_ID) return storedCustomTheme() ?? defaultTheme();
  if (id) {
    const builtin = findTheme(id);
    if (builtin) return builtin;
  }
  return defaultTheme();
}

/**
 * Applies a theme for one mode. All tokens are written as CSS custom
 * properties, so themes stay plain data and no rule needs its own selector.
 *
 * Themes reach this function from persisted browser state, so an incomplete
 * definition falls back to the default palette instead of throwing.
 */
export function applyTheme(theme: ThemeDefinition, mode: Mode): void {
  applyMode(mode);

  const fallback = defaultTheme();
  // A theme without a complete token set for this mode is not usable: fall back
  // as a whole, so id and colours cannot disagree.
  const resolved = readTokens(theme, mode) ? theme : fallback;
  const tokens = readTokens(resolved, mode) as ThemeTokens;
  const id = resolved.id;

  const root = document.documentElement;
  root.dataset.theme = id;

  for (const key of TOKEN_KEYS) {
    root.style.setProperty(TOKEN_VARS[key], tokens[key]);
  }

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', tokens.paper);

  writeItem(THEME_KEY, id);
  if (id === CUSTOM_THEME_ID && readTokens(resolved, 'light') && readTokens(resolved, 'dark')) {
    writeItem(CUSTOM_KEY, serializeTheme(resolved).trim());
  }
}

/** The token set of one mode, or `null` when it is not complete. */
function readTokens(theme: ThemeDefinition, mode: Mode): ThemeTokens | null {
  const candidate = theme?.[mode] as Record<string, unknown> | undefined;
  if (!candidate || typeof candidate !== 'object') return null;
  for (const key of TOKEN_KEYS) {
    if (typeof candidate[key] !== 'string') return null;
  }
  return candidate as ThemeTokens;
}

/** Forgets the browser's custom theme and falls back to the default. */
export function clearCustomTheme(): void {
  removeItem(CUSTOM_KEY);
  if (readItem(THEME_KEY) === CUSTOM_THEME_ID) {
    writeItem(THEME_KEY, DEFAULT_THEME_ID);
  }
}
