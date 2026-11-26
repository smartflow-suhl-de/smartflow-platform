import type { ReactNode } from 'react';

import { createElement } from 'react';
import { DiscoveryPublicPage } from '../pages/DiscoveryPublic';
import { getMessages, storedLocale } from './i18n';

/**
 * Public routes: pages that render without a session, outside the app shell.
 *
 * The list of paths lives here and nowhere else. `App` asks `matchPublicRoute`
 * before it probes the session, so a public path never triggers `/auth/me`, a
 * login redirect or the global 401 handler.
 */
export interface PublicRoute {
  /** Path pattern; `:name` segments capture one path segment each. */
  pattern: string;
  /** Page for the route. Rendered inside `PublicLayout`. */
  render: (params: Record<string, string>) => ReactNode;
  /** Document title for the page, without the platform name. Optional. */
  title?: (params: Record<string, string>) => string | undefined;
}

/** A public route's path and the rule each `:param` must satisfy. */
export interface PublicPattern {
  pattern: string;
  /** Per-parameter rule on the decoded value. Parameters without one use `OPAQUE_ID`. */
  params?: Record<string, RegExp>;
}

/**
 * Default rule for a path parameter: an opaque identifier. No dots, slashes,
 * backslashes, `?`, `#` or control characters, so a decoded value can never act
 * as a path (`..`, `%2F`) or leak into another route or request.
 */
export const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** All public routes, kept apart from the page components. */
export const publicPatterns: readonly PublicPattern[] = [
  { pattern: '/d/:token', params: { token: /^[A-Za-z0-9_-]{20,64}$/ } },
];

/**
 * Registered pages by pattern. A plugin adds its page here; a pattern in
 * `publicPatterns` without an entry shows the "link unavailable" notice.
 */
export const publicRoutes: PublicRoute[] = [];

export interface PublicMatch {
  pattern: string;
  params: Record<string, string>;
  route: PublicRoute | null;
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function matchPattern(entry: PublicPattern, pathname: string): Record<string, string> | null {
  const want = entry.pattern.split('/').filter(Boolean);
  const have = pathname.split('/').filter(Boolean);
  if (want.length !== have.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i += 1) {
    const expected = want[i]!;
    const actual = have[i]!;
    if (expected.startsWith(':')) {
      const name = expected.slice(1);
      const decoded = safeDecode(actual);
      if (decoded === null) return null;
      if (!(entry.params?.[name] ?? OPAQUE_ID).test(decoded)) return null;
      params[name] = decoded;
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

/**
 * True when the first segment belongs to a public route. Such a path is public
 * even when the full match fails, so a broken link gets the public notice and
 * never reaches the session probe.
 */
export function isPublicNamespace(pathname: string): boolean {
  const first = pathname.split('/').filter(Boolean)[0];
  if (!first) return false;
  return publicPatterns.some((entry) => entry.pattern.split('/').filter(Boolean)[0] === first);
}

/** Match a normalized pathname against the public routes, or return null. */
export function matchPublicRoute(pathname: string): PublicMatch | null {
  for (const entry of publicPatterns) {
    const params = matchPattern(entry, pathname);
    if (params) {
      const route = publicRoutes.find((item) => item.pattern === entry.pattern) ?? null;
      return { pattern: entry.pattern, params, route };
    }
  }
  return null;
}

export function isPublicPath(pathname: string): boolean {
  return matchPublicRoute(pathname) !== null;
}

// The automation discovery interview renders inside `PublicLayout`, which
// already provides brand header, main landmark, title and noindex. Registering
// here keeps page-specific paths out of `App`.
export function registerDiscoveryPublicRoute(): void {
  if (publicRoutes.some((route) => route.pattern === '/d/:token')) return;
  publicRoutes.push({
    pattern: '/d/:token',
    title: () => getMessages(storedLocale()).discovery.publicTitle,
    render: ({ token }) => {
      const locale = storedLocale();
      return createElement(DiscoveryPublicPage, {
        // A different link is a different interview: without the key React
        // keeps closed/values/hint from the previous token.
        key: token,
        token,
        locale,
        messages: getMessages(locale),
      });
    },
  });
}

registerDiscoveryPublicRoute();
