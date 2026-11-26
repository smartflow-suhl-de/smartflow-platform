import type { AuthMe } from './types';
import { api } from './api';

/**
 * Sign-in helpers shared by the login page.
 *
 * A magic-link token is single-use on the server, so the same token must never
 * be spent twice. React StrictMode mounts effects twice in development and a
 * double click can start a second submit; both would burn the token and land
 * the user on "link invalid". The in-flight map collapses those calls into one
 * request.
 */
const inFlightConfirmations = new Map<string, Promise<AuthMe>>();

export function confirmMagicLinkOnce(token: string): Promise<AuthMe> {
  const existing = inFlightConfirmations.get(token);
  if (existing) return existing;

  const pending = api.confirmMagicLink(token).finally(() => {
    inFlightConfirmations.delete(token);
  });
  inFlightConfirmations.set(token, pending);
  return pending;
}

/** How many confirmations are currently in flight. Test seam. */
export function pendingConfirmationCount(): number {
  return inFlightConfirmations.size;
}

/**
 * Turn an absolute magic link into a same-origin path the SPA router accepts.
 * Anything that does not parse is returned unchanged, so a broken link still
 * produces a readable error instead of a crash.
 */
export function toAppHref(link: string, origin: string): string {
  try {
    const parsed = new URL(link, origin);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return link;
  }
}

/** Read the token from the confirm route's query string, or null. */
export function tokenFromSearch(search: string): string | null {
  const token = new URLSearchParams(search).get('token');
  return token && token.trim().length > 0 ? token : null;
}
