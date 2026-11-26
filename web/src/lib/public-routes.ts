import type { ReactNode } from 'react';

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
}

/** Path patterns of all public routes, kept apart from the page components. */
export const publicPatterns: readonly string[] = ['/d/:token'];

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

function matchPattern(pattern: string, pathname: string): Record<string, string> | null {
  const want = pattern.split('/').filter(Boolean);
  const have = pathname.split('/').filter(Boolean);
  if (want.length !== have.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i += 1) {
    const expected = want[i]!;
    const actual = have[i]!;
    if (expected.startsWith(':')) {
      const decoded = safeDecode(actual);
      if (decoded === null || decoded.length === 0) return null;
      params[expected.slice(1)] = decoded;
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

/** Match a normalized pathname against the public routes, or return null. */
export function matchPublicRoute(pathname: string): PublicMatch | null {
  for (const pattern of publicPatterns) {
    const params = matchPattern(pattern, pathname);
    if (params) {
      const route = publicRoutes.find((entry) => entry.pattern === pattern) ?? null;
      return { pattern, params, route };
    }
  }
  return null;
}

export function isPublicPath(pathname: string): boolean {
  return matchPublicRoute(pathname) !== null;
}
