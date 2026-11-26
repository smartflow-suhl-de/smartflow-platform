import type { Messages } from './i18n';
import { normalizePath } from './router';
import type { NavEntry, Role } from './types';

export interface ResolvedNavItem {
  id: string;
  plugin: string;
  label: string;
  path: string;
  group: 'work' | 'management';
  icon: string;
  order: number;
  roles: Role[];
  createLabel: string | null;
  aliases: string[];
  utility?: boolean;
  badge?: { value: number; tone: 'signal' | 'bad' };
}

export function buildNavigation(
  role: Role,
  apiItems: NavEntry[],
  messages: Messages,
  suspendedCount = 0,
): ResolvedNavItem[] {
  const coreItems: Array<NavEntry & { utility?: boolean }> = [
    {
      plugin: 'core-overview',
      label: messages.navItems.overview,
      path: '/',
      group: 'work',
      icon: 'gauge',
      order: 10,
      roles: ['operator', 'tenant_admin', 'employee'],
      createLabel: null,
      aliases: ['/overview'],
    },
    {
      plugin: 'tenants',
      label: messages.navItems.tenants,
      path: '/tenants',
      group: 'management',
      icon: 'building',
      order: 20,
      roles: ['operator'],
      createLabel: messages.navItems.tenantsCreate,
      aliases: ['/mandanten'],
    },
    {
      plugin: 'core-settings',
      label: messages.navItems.settings,
      path: '/settings',
      group: 'management',
      icon: 'settings',
      order: 90,
      roles: ['operator', 'tenant_admin', 'employee'],
      createLabel: null,
      aliases: ['/einstellungen'],
      utility: true,
    },
    {
      plugin: 'core-help',
      label: messages.navItems.help,
      path: '/help',
      group: 'management',
      icon: 'circle-help',
      order: 95,
      roles: ['operator', 'tenant_admin', 'employee'],
      createLabel: null,
      aliases: ['/hilfe'],
      utility: true,
    },
  ];

  const byPath = new Map<string, NavEntry & { utility?: boolean }>();
  for (const item of coreItems) {
    byPath.set(item.path, item);
  }
  for (const item of apiItems) {
    byPath.set(item.path, item);
  }

  return [...byPath.values()]
    .filter((entry) => entry.roles.includes(role))
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label, 'de'))
    .map((entry) => ({
      id: `${entry.plugin}:${entry.path}`,
      ...entry,
      ...(entry.path === '/tenants' && suspendedCount > 0
        ? { badge: { value: suspendedCount, tone: 'bad' as const } }
        : {}),
    }));
}

export function groupNavigation(
  items: ResolvedNavItem[],
): Array<{ group: 'work' | 'management'; items: ResolvedNavItem[] }> {
  const groups: Array<{ group: 'work' | 'management'; items: ResolvedNavItem[] }> = [];
  for (const groupName of ['work', 'management'] as const) {
    const matching = items.filter((item) => !item.utility && item.group === groupName);
    if (matching.length > 0) {
      groups.push({ group: groupName, items: matching });
    }
  }
  return groups;
}

export function utilityNavigation(items: ResolvedNavItem[]): ResolvedNavItem[] {
  return items.filter((item) => item.utility === true);
}

export function resolveAliasRedirect(pathname: string, items: ResolvedNavItem[]): string | null {
  // A trailing or doubled slash must not defeat the alias match: `/mandanten/`
  // is the same address as `/mandanten`.
  const requested = normalizePath(pathname);
  for (const item of items) {
    if (item.aliases.some((alias) => normalizePath(alias) === requested)) {
      return item.path;
    }
  }
  return null;
}

/**
 * The navigation label for a path, or null for a path no entry covers.
 *
 * An exact match always wins; `/` matches only itself (otherwise every route
 * would inherit the overview title). Otherwise the longest entry prefix owns
 * the path, so a nested plugin route keeps its own title instead of the one of
 * a shorter sibling.
 */
export function pageTitle(pathname: string, items: ResolvedNavItem[]): string | null {
  const exact = items.find((item) => item.path === pathname);
  if (exact) return exact.label;

  let best: ResolvedNavItem | null = null;
  for (const item of items) {
    if (item.path === '/' || !pathname.startsWith(`${item.path}/`)) continue;
    if (!best || item.path.length > best.path.length) best = item;
  }
  return best?.label ?? null;
}
