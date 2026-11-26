/**
 * Theme catalog and theme-file format.
 *
 * A theme is pure data: fourteen colour tokens per mode, every one a validated
 * `#rrggbb` hex value. Nothing here touches the DOM or storage, so the same
 * definitions can be shipped as code, pasted as JSON or produced by an AI.
 */
import type { Locale } from './i18n';
import {
  contrastRatio,
  ensureContrast,
  isHexColor,
  mix,
  normalizeHex,
  relativeLuminance,
} from './theme-color';

export type Mode = 'light' | 'dark';

export const TOKEN_KEYS = [
  'paper',
  'paperRaised',
  'surface',
  'ink',
  'inkSoft',
  'inkMuted',
  'line',
  'lineStrong',
  'cobalt',
  'cobaltDeep',
  'signal',
  'good',
  'warn',
  'bad',
] as const;

export type TokenKey = (typeof TOKEN_KEYS)[number];

export type ThemeTokens = Record<TokenKey, string>;

export interface LocalizedText {
  de: string;
  en: string;
}

export interface ThemeDefinition {
  /** `custom` for the single theme stored in this browser. */
  id: string;
  label: LocalizedText;
  description: LocalizedText;
  builtin: boolean;
  light: ThemeTokens;
  dark: ThemeTokens;
}

export const DEFAULT_THEME_ID = 'instrument';
export const CUSTOM_THEME_ID = 'custom';

interface ContrastRule {
  foreground: TokenKey;
  background: TokenKey;
  minimum: number;
}

/**
 * Readability floor for every theme, imported ones included. Text tokens reach
 * WCAG AA (4.5:1), body text aims higher; `signal` is a decorative accent and
 * only has to stay visible.
 */
export const CONTRAST_RULES: readonly ContrastRule[] = [
  { foreground: 'ink', background: 'paper', minimum: 12 },
  { foreground: 'ink', background: 'paperRaised', minimum: 12 },
  { foreground: 'ink', background: 'surface', minimum: 12 },
  { foreground: 'inkSoft', background: 'paper', minimum: 5.5 },
  { foreground: 'inkSoft', background: 'surface', minimum: 5.5 },
  { foreground: 'inkMuted', background: 'paper', minimum: 4.5 },
  { foreground: 'inkMuted', background: 'surface', minimum: 4.5 },
  { foreground: 'cobalt', background: 'paper', minimum: 4.5 },
  { foreground: 'cobalt', background: 'surface', minimum: 4.5 },
  { foreground: 'good', background: 'paper', minimum: 4.5 },
  { foreground: 'good', background: 'surface', minimum: 4.5 },
  { foreground: 'warn', background: 'paper', minimum: 4.5 },
  { foreground: 'warn', background: 'surface', minimum: 4.5 },
  { foreground: 'bad', background: 'paper', minimum: 4.5 },
  { foreground: 'bad', background: 'surface', minimum: 4.5 },
  { foreground: 'signal', background: 'paper', minimum: 2.5 },
  { foreground: 'signal', background: 'surface', minimum: 2.5 },
];

const PALETTES: Record<string, { light: ThemeTokens; dark: ThemeTokens }> = {
  instrument: {
    light: {
      paper: '#f2efe7',
      paperRaised: '#faf8f2',
      surface: '#ffffff',
      ink: '#12161a',
      inkSoft: '#454c52',
      inkMuted: '#5f676d',
      line: '#ddd7c8',
      lineStrong: '#b9b2a0',
      cobalt: '#1e3bff',
      cobaltDeep: '#1428b8',
      signal: '#ff5a1f',
      good: '#0b7a53',
      warn: '#7a4a00',
      bad: '#bb2d1e',
    },
    dark: {
      paper: '#0d1013',
      paperRaised: '#14181c',
      surface: '#171c21',
      ink: '#eef0ea',
      inkSoft: '#b5bcc2',
      inkMuted: '#98a1a8',
      line: '#262c31',
      lineStrong: '#3b434a',
      cobalt: '#6d84ff',
      cobaltDeep: '#4b62ff',
      signal: '#ff7a45',
      good: '#3ddb9f',
      warn: '#f0b447',
      bad: '#ff6b57',
    },
  },
  nordlicht: {
    light: {
      paper: '#eef1f6',
      paperRaised: '#f6f9fd',
      surface: '#ffffff',
      ink: '#0f1720',
      inkSoft: '#3d4a58',
      inkMuted: '#596673',
      line: '#d3dae3',
      lineStrong: '#aeb9c6',
      cobalt: '#1d4ed8',
      cobaltDeep: '#1e3a8a',
      signal: '#d9480f',
      good: '#0f6b4f',
      warn: '#7a4a00',
      bad: '#b3211a',
    },
    dark: {
      paper: '#0b1118',
      paperRaised: '#111922',
      surface: '#151f2a',
      ink: '#e8eef5',
      inkSoft: '#b3c0cd',
      inkMuted: '#94a3b3',
      line: '#233040',
      lineStrong: '#35455a',
      cobalt: '#7ea2ff',
      cobaltDeep: '#5b83ff',
      signal: '#ff8a4c',
      good: '#48d6a4',
      warn: '#f2ba56',
      bad: '#ff7b6b',
    },
  },
  archiv: {
    light: {
      paper: '#f4eddc',
      paperRaised: '#fbf6ea',
      surface: '#fffdf7',
      ink: '#1d1a13',
      inkSoft: '#4d4433',
      inkMuted: '#675c47',
      line: '#e2d7bd',
      lineStrong: '#bfae8c',
      cobalt: '#7b2d26',
      cobaltDeep: '#5f201a',
      signal: '#c2410c',
      good: '#2f6b46',
      warn: '#7a4a00',
      bad: '#a32015',
    },
    dark: {
      paper: '#14110c',
      paperRaised: '#1b1711',
      surface: '#221c15',
      ink: '#f1e9d8',
      inkSoft: '#c9bda6',
      inkMuted: '#a4967e',
      line: '#33291d',
      lineStrong: '#4a3c2c',
      cobalt: '#f0a878',
      cobaltDeep: '#e08a52',
      signal: '#ff9a5c',
      good: '#67d3a1',
      warn: '#f0b447',
      bad: '#ff8574',
    },
  },
  kontrast: {
    light: {
      paper: '#ffffff',
      paperRaised: '#ffffff',
      surface: '#ffffff',
      ink: '#000000',
      inkSoft: '#1a1a1a',
      inkMuted: '#333333',
      line: '#8a8a8a',
      lineStrong: '#3d3d3d',
      cobalt: '#0037c4',
      cobaltDeep: '#002a96',
      signal: '#b33000',
      good: '#005c3c',
      warn: '#5c3800',
      bad: '#a30000',
    },
    dark: {
      paper: '#000000',
      paperRaised: '#0a0a0a',
      surface: '#111111',
      ink: '#ffffff',
      inkSoft: '#e6e6e6',
      inkMuted: '#cfcfcf',
      line: '#3a3a3a',
      lineStrong: '#8a8a8a',
      cobalt: '#8fb0ff',
      cobaltDeep: '#a9c0ff',
      signal: '#ff9a5c',
      good: '#4fe0a8',
      warn: '#ffcc66',
      bad: '#ff8b7a',
    },
  },
};

interface CatalogEntry {
  id: string;
  label: LocalizedText;
  description: LocalizedText;
}

const CATALOG: readonly CatalogEntry[] = [
  {
    id: 'instrument',
    label: { de: 'Instrument', en: 'Instrument' },
    description: {
      de: 'Papier, Tinte und Kobalt — das Standarddesign.',
      en: 'Paper, ink and cobalt — the default design.',
    },
  },
  {
    id: 'nordlicht',
    label: { de: 'Nordlicht', en: 'Northern light' },
    description: {
      de: 'Kühles Graublau mit tiefem Blau als Akzent.',
      en: 'Cool grey-blue with a deep blue accent.',
    },
  },
  {
    id: 'archiv',
    label: { de: 'Archiv', en: 'Archive' },
    description: {
      de: 'Warmes Papier und ein gedämpftes Rotbraun.',
      en: 'Warm paper and a muted red-brown.',
    },
  },
  {
    id: 'kontrast',
    label: { de: 'Kontrast', en: 'Contrast' },
    description: {
      de: 'Schwarz auf Weiß mit maximaler Lesbarkeit.',
      en: 'Black on white with maximum legibility.',
    },
  },
];

export const BUILTIN_THEMES: readonly ThemeDefinition[] = CATALOG.map((entry) => ({
  ...entry,
  builtin: true,
  light: { ...PALETTES[entry.id].light },
  dark: { ...PALETTES[entry.id].dark },
}));

export function findTheme(id: string): ThemeDefinition | undefined {
  return BUILTIN_THEMES.find((theme) => theme.id === id);
}

export function defaultTheme(): ThemeDefinition {
  const theme = findTheme(DEFAULT_THEME_ID);
  if (!theme) throw new Error('default theme missing');
  return theme;
}

export function themeLabel(theme: ThemeDefinition, locale: Locale): string {
  return theme.label[locale];
}

export function themeDescription(theme: ThemeDefinition, locale: Locale): string {
  return theme.description[locale];
}

export function tokensFor(theme: ThemeDefinition, mode: Mode): ThemeTokens {
  return theme[mode];
}

function normalizeTokens(tokens: ThemeTokens): ThemeTokens {
  const normalized = {} as ThemeTokens;
  for (const key of TOKEN_KEYS) normalized[key] = normalizeHex(tokens[key]);
  return normalized;
}

/** Contrast violations of a theme, one readable line per broken rule. */
export function contrastProblems(theme: ThemeDefinition): string[] {
  const problems: string[] = [];
  for (const mode of ['light', 'dark'] as const) {
    const tokens = theme[mode];
    for (const rule of CONTRAST_RULES) {
      const ratio = contrastRatio(tokens[rule.foreground], tokens[rule.background]);
      if (ratio + 0.01 < rule.minimum) {
        problems.push(
          `${mode}: ${rule.foreground} on ${rule.background} is ${ratio.toFixed(2)}:1 (needs ${rule.minimum}:1)`,
        );
      }
    }
  }
  return problems;
}

// --- Custom theme derivation ----------------------------------------------

export interface CustomThemeInput {
  name: string;
  accent: string;
  paper: string;
}

export const NAME_MAX_LENGTH = 40;
export const PAPER_MIN_LUMINANCE = 0.5;

export function isValidThemeName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > NAME_MAX_LENGTH) return false;
  return Array.from(trimmed).every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 32 && code !== 127;
  });
}

export function customThemeProblems(input: CustomThemeInput): string[] {
  const problems: string[] = [];
  if (!isValidThemeName(input.name)) problems.push('name');
  if (!isHexColor(input.accent)) problems.push('accent');
  if (!isHexColor(input.paper)) problems.push('paper');
  if (isHexColor(input.paper) && relativeLuminance(input.paper) < PAPER_MIN_LUMINANCE) {
    problems.push('paper_too_dark');
  }
  return problems;
}

function deriveLight(paper: string, accent: string): ThemeTokens {
  const ink = ensureContrast(mix(paper, '#000000', 0.93), paper, 12);
  const inkSoft = ensureContrast(mix(paper, ink, 0.62), paper, 5.6);
  const inkMuted = ensureContrast(mix(paper, ink, 0.5), paper, 4.7);
  const cobalt = ensureContrast(accent, paper, 4.8);
  return {
    paper: normalizeHex(paper),
    paperRaised: mix(paper, '#ffffff', 0.55),
    surface: mix(paper, '#ffffff', 0.9),
    ink,
    inkSoft,
    inkMuted,
    line: mix(paper, ink, 0.1),
    lineStrong: mix(paper, ink, 0.26),
    cobalt,
    cobaltDeep: ensureContrast(mix(cobalt, '#000000', 0.24), paper, 6),
    signal: ensureContrast('#ff5a1f', paper, 3),
    good: ensureContrast('#0b7a53', paper, 4.6),
    warn: ensureContrast('#7a4a00', paper, 4.6),
    bad: ensureContrast('#bb2d1e', paper, 4.6),
  };
}

function deriveDark(paper: string, accent: string): ThemeTokens {
  const base = mix('#0d1013', paper, 0.06);
  const ink = ensureContrast(mix(base, '#eef0ea', 0.94), base, 12);
  const inkSoft = ensureContrast(mix(base, ink, 0.72), base, 6);
  const inkMuted = ensureContrast(mix(base, ink, 0.6), base, 4.8);
  const cobalt = ensureContrast(accent, base, 4.8);
  return {
    paper: base,
    paperRaised: mix(base, '#ffffff', 0.03),
    surface: mix(base, '#ffffff', 0.06),
    ink,
    inkSoft,
    inkMuted,
    line: mix(base, ink, 0.12),
    lineStrong: mix(base, ink, 0.3),
    cobalt,
    cobaltDeep: ensureContrast(mix(cobalt, '#ffffff', 0.18), base, 6),
    signal: ensureContrast('#ff7a45', base, 3),
    good: ensureContrast('#3ddb9f', base, 4.6),
    warn: ensureContrast('#f0b447', base, 4.6),
    bad: ensureContrast('#ff6b57', base, 4.6),
  };
}

/**
 * Last step of the derivation: moves a foreground token until every rule
 * passes. Tokens only ever move towards black or white, which helps on every
 * background of the same mode, so one pass is enough.
 */
function enforceRules(tokens: ThemeTokens): ThemeTokens {
  const fixed = { ...tokens };
  for (const rule of CONTRAST_RULES) {
    const ratio = contrastRatio(fixed[rule.foreground], fixed[rule.background]);
    if (ratio + 0.01 < rule.minimum) {
      fixed[rule.foreground] = ensureContrast(
        fixed[rule.foreground],
        fixed[rule.background],
        rule.minimum + 0.05,
      );
    }
  }
  return fixed;
}

/** Derives a complete, contrast-checked custom theme from accent and paper. */
export function buildCustomTheme(input: CustomThemeInput): ThemeDefinition {
  const problems = customThemeProblems(input);
  if (problems.length > 0) throw new Error(`invalid custom theme: ${problems.join(', ')}`);
  const name = input.name.trim();
  return {
    id: CUSTOM_THEME_ID,
    label: { de: name, en: name },
    description: {
      de: 'Eigenes Theme aus Akzent- und Papierfarbe.',
      en: 'Custom theme from an accent and a paper colour.',
    },
    builtin: false,
    light: enforceRules(deriveLight(input.paper, input.accent)),
    dark: enforceRules(deriveDark(input.paper, input.accent)),
  };
}

// --- Theme file (JSON) -----------------------------------------------------

export const THEME_FILE_VERSION = 1;

export type ThemeFileError =
  | 'invalid_json'
  | 'invalid_shape'
  | 'invalid_version'
  | 'invalid_name'
  | 'invalid_color'
  | 'paper_too_dark'
  | 'low_contrast';

export type ParseThemeResult =
  { ok: true; theme: ThemeDefinition } | { ok: false; error: ThemeFileError; detail?: string };

function parseTokens(candidate: unknown): ThemeTokens | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const record = candidate as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== TOKEN_KEYS.length) return null;
  const tokens = {} as ThemeTokens;
  for (const key of TOKEN_KEYS) {
    const value = record[key];
    if (!isHexColor(value)) return null;
    tokens[key] = normalizeHex(value);
  }
  return tokens;
}

function readName(candidate: unknown): string | null {
  return typeof candidate === 'string' && isValidThemeName(candidate) ? candidate.trim() : null;
}

/**
 * Accepts two shapes, both with `schemaVersion: 1`:
 *
 * - `{ name, accent, paper }` — complete tokens are derived and checked.
 * - `{ name, light, dark }` — full token sets, checked as given.
 *
 * Unknown keys are rejected rather than ignored, so a typo cannot silently
 * produce a theme that looks nothing like the file.
 */
export function parseThemeFile(text: string): ParseThemeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'invalid_shape' };
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== undefined && record.schemaVersion !== THEME_FILE_VERSION) {
    return { ok: false, error: 'invalid_version' };
  }

  const compactKeys = new Set(['schemaVersion', 'name', 'accent', 'paper']);
  const fullKeys = new Set(['schemaVersion', 'name', 'light', 'dark']);
  const keys = Object.keys(record);
  const isCompact = keys.every((key) => compactKeys.has(key)) && 'accent' in record;
  const isFull = keys.every((key) => fullKeys.has(key)) && 'light' in record && 'dark' in record;
  if (isCompact === isFull) return { ok: false, error: 'invalid_shape' };

  const name = readName(record.name);
  if (!name) return { ok: false, error: 'invalid_name' };

  if (isCompact) {
    const accent = record.accent;
    const paper = record.paper;
    if (!isHexColor(accent) || !isHexColor(paper)) {
      return { ok: false, error: 'invalid_color' };
    }
    if (relativeLuminance(paper) < PAPER_MIN_LUMINANCE) {
      return { ok: false, error: 'paper_too_dark' };
    }
    return { ok: true, theme: buildCustomTheme({ name, accent, paper }) };
  }

  const light = parseTokens(record.light);
  const dark = parseTokens(record.dark);
  if (!light || !dark) return { ok: false, error: 'invalid_color' };

  const theme: ThemeDefinition = {
    id: CUSTOM_THEME_ID,
    label: { de: name, en: name },
    description: {
      de: 'Eigenes Theme aus einer Theme-Datei.',
      en: 'Custom theme from a theme file.',
    },
    builtin: false,
    light,
    dark,
  };
  const problems = contrastProblems(theme);
  if (problems.length > 0) {
    return { ok: false, error: 'low_contrast', detail: problems[0] };
  }
  return { ok: true, theme };
}

/** Complete theme file for export; importing it reproduces the theme exactly. */
export function serializeTheme(theme: ThemeDefinition): string {
  return `${JSON.stringify(
    {
      schemaVersion: THEME_FILE_VERSION,
      name: theme.label.de,
      light: normalizeTokens(theme.light),
      dark: normalizeTokens(theme.dark),
    },
    null,
    2,
  )}\n`;
}

/** Swatch colours for the picker, in reading order. */
export function themeSwatches(theme: ThemeDefinition, mode: Mode): string[] {
  const tokens = tokensFor(theme, mode);
  return [tokens.paper, tokens.ink, tokens.cobalt, tokens.signal];
}
