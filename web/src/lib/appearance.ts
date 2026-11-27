/**
 * The appearance cycle behind the sidebar footer switch.
 *
 * One click steps through every theme/mode pair and wraps around. The list is
 * derived from the built-in catalog plus the browser's own theme, so a new
 * theme joins the cycle without touching this module.
 *
 * It is pure data in and data out: no storage, no DOM. The caller starts from
 * the persisted pair and writes the result with the same functions the topbar
 * switch uses (`applyTheme`), so nothing becomes a second source of truth.
 */
import {
  BUILTIN_THEMES,
  CUSTOM_THEME_ID,
  findTheme,
  type Mode,
  type ThemeDefinition,
} from './themes';
import type { Locale, Messages } from './i18n';

export interface AppearancePair {
  themeId: string;
  mode: Mode;
}

/** The order of modes within one theme: light first, then dark. */
const MODES: readonly Mode[] = ['light', 'dark'];

/**
 * Every appearance the switch cycles through, in order: each built-in theme in
 * light and dark, then the custom theme when the browser has one.
 */
export function appearanceCycle(customTheme: ThemeDefinition | null): AppearancePair[] {
  const cycle: AppearancePair[] = [];
  for (const theme of BUILTIN_THEMES) {
    for (const mode of MODES) cycle.push({ themeId: theme.id, mode });
  }
  if (customTheme && customTheme.id === CUSTOM_THEME_ID) {
    for (const mode of MODES) cycle.push({ themeId: customTheme.id, mode });
  }
  return cycle;
}

function indexOfPair(cycle: AppearancePair[], current: AppearancePair): number {
  const exact = cycle.findIndex(
    (step) => step.themeId === current.themeId && step.mode === current.mode,
  );
  if (exact >= 0) return exact;
  // A theme that is not in the catalog any more still has a place: start from
  // its light variant (or the next entry of another theme), never from a
  // negative index that would wrap to the end.
  return Math.max(
    0,
    cycle.findIndex((step) => step.themeId === current.themeId),
  );
}

/** The appearance after one click, wrapping from the last entry to the first. */
export function nextAppearance(
  current: AppearancePair,
  customTheme: ThemeDefinition | null,
): AppearancePair {
  const cycle = appearanceCycle(customTheme);
  if (cycle.length === 0) {
    // The catalog always has entries; this only guards a future refactor.
    return { themeId: 'instrument', mode: 'light' };
  }
  return cycle[(indexOfPair(cycle, current) + 1) % cycle.length];
}

/** Human-readable name of one appearance, e.g. "Nordlicht dunkel". */
export function appearanceName(
  pair: AppearancePair,
  customTheme: ThemeDefinition | null,
  locale: Locale,
  messages: Messages,
): string {
  const theme =
    pair.themeId === CUSTOM_THEME_ID ? (customTheme ?? undefined) : findTheme(pair.themeId);
  const mode =
    pair.mode === 'dark' ? messages.shell.appearanceDark : messages.shell.appearanceLight;
  const name = theme?.label[locale];
  return name ? `${name} ${mode}` : mode;
}
