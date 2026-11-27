import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import {
  CUSTOM_THEME_ID,
  TOKEN_KEYS,
  contrastProblems,
  defaultTheme,
  findTheme,
  type LocalizedText,
  type Mode,
  type ThemeDefinition,
  type ThemeTokens,
} from './themes';
import { isHexColor } from './theme-color';
import { applyMode, applyTheme, clearCustomTheme, storedCustomTheme, storedTheme } from '../theme';
import { applyLocale, storedLocale, type Locale } from './i18n';
import type { DiscoveryInviteStatus, TenantStatus } from './types';

export type TenantStatusFilter = 'all' | TenantStatus;
export type WebsiteOwnerFilter = 'all' | 'own' | 'client';
export type DiscoveryStatusFilter = 'all' | DiscoveryInviteStatus;

export interface TenantFilterState {
  statusFilter: TenantStatusFilter;
  query: string;
}

export interface WebsiteFilterState {
  filter: WebsiteOwnerFilter;
  query: string;
}

export interface DiscoveryFilterState {
  statusFilter: DiscoveryStatusFilter;
  query: string;
}

export interface PreferencesState {
  mode: Mode;
  theme: ThemeDefinition;
  customTheme: ThemeDefinition | null;
  locale: Locale;
}

export interface UiPersistedState {
  tenants: TenantFilterState;
  websites: WebsiteFilterState;
  discovery: DiscoveryFilterState;
  preferences: PreferencesState;
}

export interface UiState extends UiPersistedState {
  setTenantFilter: (patch: Partial<TenantFilterState>) => void;
  resetTenantFilter: () => void;
  setWebsiteFilter: (patch: Partial<WebsiteFilterState>) => void;
  resetWebsiteFilter: () => void;
  setDiscoveryFilter: (patch: Partial<DiscoveryFilterState>) => void;
  resetDiscoveryFilter: () => void;
  setMode: (mode: Mode) => void;
  setTheme: (theme: ThemeDefinition) => void;
  setCustomTheme: (customTheme: ThemeDefinition | null) => void;
  removeCustomTheme: () => void;
  setLocale: (locale: Locale) => void;
  resetAllFilters: () => void;
}

const memoryFallback = new Map<string, string>();

export const safeLocalStorage: StateStorage = {
  getItem: (name: string): string | null => {
    try {
      if (typeof localStorage !== 'undefined') {
        const val = localStorage.getItem(name);
        if (val !== null) return val;
      }
    } catch {
      /* storage blocked or in private mode */
    }
    return memoryFallback.get(name) ?? null;
  },
  setItem: (name: string, value: string): void => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(name, value);
        return;
      }
    } catch {
      /* storage blocked or quota exceeded */
    }
    memoryFallback.set(name, value);
  },
  removeItem: (name: string): void => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(name);
      }
    } catch {
      /* storage blocked */
    }
    memoryFallback.delete(name);
  },
};

export function clearMemoryFallback(): void {
  memoryFallback.clear();
}

const defaultTenants: TenantFilterState = {
  statusFilter: 'all',
  query: '',
};

const defaultWebsites: WebsiteFilterState = {
  filter: 'all',
  query: '',
};

const defaultDiscovery: DiscoveryFilterState = {
  statusFilter: 'all',
  query: '',
};

function isTokenRecord(value: unknown): value is ThemeTokens {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return TOKEN_KEYS.every((key) => isHexColor(record[key]));
}

function readLabel(value: unknown): LocalizedText {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    de: typeof record.de === 'string' ? record.de : '',
    en: typeof record.en === 'string' ? record.en : '',
  };
}

/**
 * A structurally complete theme. Persisted state can be stale or hand-edited,
 * so anything that is not `{ id, light, dark }` with all hex tokens is refused
 * here instead of failing later inside `applyTheme`.
 */
export function isThemeDefinition(value: unknown): value is ThemeDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.trim() === '') return false;
  return isTokenRecord(record.light) && isTokenRecord(record.dark);
}

/** Rebuilds a theme from persisted data, or `null` when it is unusable. */
export function sanitizeTheme(value: unknown): ThemeDefinition | null {
  if (!isThemeDefinition(value)) return null;
  const record = value as ThemeDefinition & Record<string, unknown>;
  return {
    id: record.id,
    label: readLabel(record.label),
    description: readLabel(record.description),
    builtin: record.builtin === true,
    light: { ...record.light },
    dark: { ...record.dark },
  };
}

/**
 * A stored custom theme is only usable when it still passes every contrast
 * rule. The importer enforces the same rules, so a theme that fails here was
 * edited by hand, comes from an older rule set, or is not a SmartFlow theme at
 * all; the default palette is the safe answer.
 */
export function sanitizeCustomTheme(value: unknown): ThemeDefinition | null {
  const theme = sanitizeTheme(value);
  if (!theme) return null;
  return contrastProblems(theme).length === 0 ? theme : null;
}

/**
 * The theme to use after loading persisted state: the stored custom theme when
 * it is intact, otherwise the built-in with the same id, otherwise the default.
 */
export function sanitizeActiveTheme(
  value: unknown,
  customTheme: ThemeDefinition | null,
): ThemeDefinition {
  // Only two kinds of theme are legitimate: the single stored custom theme and
  // a built-in. Anything else (an unknown id, a hand-edited palette) is
  // replaced, and built-ins are re-read from the catalog rather than trusted.
  if (value && typeof value === 'object') {
    const id = (value as Record<string, unknown>).id;
    if (typeof id === 'string') {
      if (id === CUSTOM_THEME_ID) return customTheme ?? defaultTheme();
      const builtin = findTheme(id);
      if (builtin) return builtin;
    }
  }
  return defaultTheme();
}

function safeStoredMode(): Mode {
  try {
    if (typeof localStorage !== 'undefined') {
      const value = localStorage.getItem('sf.mode');
      if (value === 'light' || value === 'dark') return value;
    }
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
  } catch {
    /* ignore */
  }
  return 'light';
}

function safeStoredTheme(): ThemeDefinition {
  try {
    if (typeof localStorage !== 'undefined') {
      return storedTheme();
    }
  } catch {
    /* ignore */
  }
  return defaultTheme();
}

function safeStoredCustomTheme(): ThemeDefinition | null {
  try {
    if (typeof localStorage !== 'undefined') {
      return storedCustomTheme();
    }
  } catch {
    /* ignore */
  }
  return null;
}

function safeStoredLocale(): Locale {
  try {
    if (typeof localStorage !== 'undefined') {
      return storedLocale();
    }
  } catch {
    /* ignore */
  }
  return 'de';
}

function safeApplyMode(mode: Mode): void {
  try {
    if (typeof document !== 'undefined') {
      applyMode(mode);
    } else if (typeof localStorage !== 'undefined') {
      localStorage.setItem('sf.mode', mode);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Applies a theme and never throws. Anything that is not a complete theme is
 * replaced by the default, so a broken persisted entry cannot take the SPA
 * down when it is replayed into the DOM.
 */
export function safeApplyTheme(theme: ThemeDefinition, mode: Mode): void {
  const target = isThemeDefinition(theme) ? theme : defaultTheme();
  try {
    if (typeof document !== 'undefined') {
      applyTheme(target, mode);
    } else if (typeof localStorage !== 'undefined') {
      localStorage.setItem('sf.theme', target.id);
    }
  } catch {
    try {
      applyTheme(defaultTheme(), mode);
    } catch {
      /* ignore */
    }
  }
}

function safeClearCustomTheme(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      clearCustomTheme();
    }
  } catch {
    /* ignore */
  }
}

function safeApplyLocale(locale: Locale): void {
  try {
    if (typeof document !== 'undefined') {
      applyLocale(locale);
    } else if (typeof localStorage !== 'undefined') {
      localStorage.setItem('sf.locale', locale);
    }
  } catch {
    /* ignore */
  }
}

export function getInitialPreferences(): PreferencesState {
  return {
    mode: safeStoredMode(),
    theme: safeStoredTheme(),
    customTheme: safeStoredCustomTheme(),
    locale: safeStoredLocale(),
  };
}

/** Locale values a persisted state may carry. */
function readLocale(value: unknown, fallback: Locale): Locale {
  return value === 'de' || value === 'en' ? value : fallback;
}

function readMode(value: unknown, fallback: Mode): Mode {
  return value === 'light' || value === 'dark' ? value : fallback;
}

function readString(value: unknown, fallback: string): string {
  // Search fields are read and persisted as text; anything else (an object, a
  // null, a huge blob) would break `query.trim()` in the pages.
  return typeof value === 'string' ? value.slice(0, MAX_QUERY_LENGTH) : fallback;
}

/** Longest search text that is accepted from persisted state. */
export const MAX_QUERY_LENGTH = 200;

const TENANT_STATUS_FILTERS: readonly TenantStatusFilter[] = ['all', 'active', 'suspended'];
const WEBSITE_OWNER_FILTERS: readonly WebsiteOwnerFilter[] = ['all', 'own', 'client'];
const DISCOVERY_STATUS_FILTERS: readonly DiscoveryStatusFilter[] = [
  'all',
  'open',
  'in_progress',
  'completed',
  'revoked',
  'expired',
];

function readOneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * Turns whatever sits under `sf.ui-state` into a complete, typed state.
 *
 * Persisted data is treated as untrusted: it can be stale after a release, or
 * edited by hand. Every field falls back to its default instead of being taken
 * as given, and the themes are validated structurally so a broken entry cannot
 * crash `applyTheme` later.
 */
export function sanitizePersistedState(persistedState: unknown): UiPersistedState {
  const raw =
    persistedState && typeof persistedState === 'object'
      ? (persistedState as Record<string, unknown>)
      : {};
  const readSection = (key: string): Record<string, unknown> => {
    const section = raw[key];
    return section && typeof section === 'object' && !Array.isArray(section)
      ? (section as Record<string, unknown>)
      : {};
  };
  const fallbackPrefs = getInitialPreferences();
  const prefs = readSection('preferences');

  const customTheme = sanitizeCustomTheme(prefs.customTheme) ?? fallbackPrefs.customTheme;
  const tenants = readSection('tenants');
  const websites = readSection('websites');
  const discovery = readSection('discovery');

  return {
    tenants: {
      statusFilter: readOneOf(
        tenants.statusFilter,
        TENANT_STATUS_FILTERS,
        defaultTenants.statusFilter,
      ),
      query: readString(tenants.query, defaultTenants.query),
    },
    websites: {
      filter: readOneOf(websites.filter, WEBSITE_OWNER_FILTERS, defaultWebsites.filter),
      query: readString(websites.query, defaultWebsites.query),
    },
    discovery: {
      statusFilter: readOneOf(
        discovery.statusFilter,
        DISCOVERY_STATUS_FILTERS,
        defaultDiscovery.statusFilter,
      ),
      query: readString(discovery.query, defaultDiscovery.query),
    },
    preferences: {
      mode: readMode(prefs.mode, fallbackPrefs.mode),
      theme: sanitizeActiveTheme(prefs.theme, customTheme),
      customTheme,
      locale: readLocale(prefs.locale, fallbackPrefs.locale),
    },
  };
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      tenants: defaultTenants,
      websites: defaultWebsites,
      discovery: defaultDiscovery,
      preferences: getInitialPreferences(),

      setTenantFilter: (patch) =>
        set((state) => ({
          tenants: { ...state.tenants, ...patch },
        })),

      resetTenantFilter: () =>
        set(() => ({
          tenants: defaultTenants,
        })),

      setWebsiteFilter: (patch) =>
        set((state) => ({
          websites: { ...state.websites, ...patch },
        })),

      resetWebsiteFilter: () =>
        set(() => ({
          websites: defaultWebsites,
        })),

      setDiscoveryFilter: (patch) =>
        set((state) => ({
          discovery: { ...state.discovery, ...patch },
        })),

      resetDiscoveryFilter: () =>
        set(() => ({
          discovery: defaultDiscovery,
        })),

      resetAllFilters: () =>
        set(() => ({
          tenants: defaultTenants,
          websites: defaultWebsites,
          discovery: defaultDiscovery,
        })),

      setMode: (mode) => {
        safeApplyMode(mode);
        set((state) => ({
          preferences: { ...state.preferences, mode },
        }));
      },

      setTheme: (theme) => {
        safeApplyTheme(theme, get().preferences.mode);
        set((state) => ({
          preferences: {
            ...state.preferences,
            theme,
            customTheme: theme.id === CUSTOM_THEME_ID ? theme : state.preferences.customTheme,
          },
        }));
      },

      setCustomTheme: (customTheme) => {
        if (customTheme) {
          safeApplyTheme(customTheme, get().preferences.mode);
          set((state) => ({
            preferences: {
              ...state.preferences,
              theme: customTheme,
              customTheme,
            },
          }));
        }
      },

      removeCustomTheme: () => {
        safeClearCustomTheme();
        set((state) => ({
          preferences: {
            ...state.preferences,
            customTheme: null,
            theme:
              state.preferences.theme.id === CUSTOM_THEME_ID
                ? defaultTheme()
                : state.preferences.theme,
          },
        }));
      },

      setLocale: (locale) => {
        safeApplyLocale(locale);
        set((state) => ({
          preferences: { ...state.preferences, locale },
        }));
      },
    }),
    {
      name: 'sf.ui-state',
      storage: createJSONStorage(() => safeLocalStorage),
      version: 1,
      partialize: (state): UiPersistedState => ({
        tenants: {
          statusFilter: state.tenants.statusFilter,
          query: state.tenants.query,
        },
        websites: {
          filter: state.websites.filter,
          query: state.websites.query,
        },
        discovery: {
          statusFilter: state.discovery.statusFilter,
          query: state.discovery.query,
        },
        preferences: {
          mode: state.preferences.mode,
          theme: state.preferences.theme,
          customTheme: state.preferences.customTheme,
          locale: state.preferences.locale,
        },
      }),
      merge: (persistedState: unknown, currentState: UiState): UiState => ({
        ...currentState,
        ...sanitizePersistedState(persistedState),
      }),
      migrate: (persistedState: unknown, _version: number): UiPersistedState =>
        sanitizePersistedState(persistedState),
      onRehydrateStorage: () => (state) => {
        if (state?.preferences) {
          safeApplyTheme(state.preferences.theme, state.preferences.mode);
          safeApplyLocale(state.preferences.locale);
        }
      },
    },
  ),
);
