import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { CUSTOM_THEME_ID, defaultTheme, type Mode, type ThemeDefinition } from './themes';
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

function safeApplyTheme(theme: ThemeDefinition, mode: Mode): void {
  try {
    if (typeof document !== 'undefined') {
      applyTheme(theme, mode);
    } else if (typeof localStorage !== 'undefined') {
      localStorage.setItem('sf.theme', theme.id);
    }
  } catch {
    /* ignore */
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
      migrate: (persistedState: unknown, _version: number): UiPersistedState => {
        const raw = (persistedState as Partial<UiPersistedState>) || {};
        const fallbackPrefs = getInitialPreferences();
        return {
          tenants: {
            statusFilter: raw.tenants?.statusFilter ?? defaultTenants.statusFilter,
            query:
              typeof raw.tenants?.query === 'string' ? raw.tenants.query : defaultTenants.query,
          },
          websites: {
            filter: raw.websites?.filter ?? defaultWebsites.filter,
            query:
              typeof raw.websites?.query === 'string' ? raw.websites.query : defaultWebsites.query,
          },
          discovery: {
            statusFilter: raw.discovery?.statusFilter ?? defaultDiscovery.statusFilter,
            query:
              typeof raw.discovery?.query === 'string'
                ? raw.discovery.query
                : defaultDiscovery.query,
          },
          preferences: {
            mode:
              raw.preferences?.mode === 'light' || raw.preferences?.mode === 'dark'
                ? raw.preferences.mode
                : fallbackPrefs.mode,
            theme: raw.preferences?.theme ?? fallbackPrefs.theme,
            customTheme: raw.preferences?.customTheme ?? fallbackPrefs.customTheme,
            locale:
              raw.preferences?.locale === 'de' || raw.preferences?.locale === 'en'
                ? raw.preferences.locale
                : fallbackPrefs.locale,
          },
        };
      },
      onRehydrateStorage: () => (state) => {
        if (state?.preferences) {
          safeApplyTheme(state.preferences.theme, state.preferences.mode);
          safeApplyLocale(state.preferences.locale);
        }
      },
    },
  ),
);
