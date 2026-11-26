import type { AuthMe, MagicLinkResponse } from './types';
import { ApiError, api, isAbortError } from './api';

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
 *
 * Only http(s) and relative links are accepted; anything with another scheme
 * (`javascript:`, `data:`, an opaque prefix) falls back to the login route
 * instead of ending up in an `href`.
 */
export function toAppHref(link: string, origin: string, fallback = '/login'): string {
  try {
    const parsed = new URL(link, origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fallback;
    if (parsed.origin !== new URL(origin).origin) return fallback;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return fallback;
  }
}

/** Read the token from the confirm route's query string, or null. */
export function tokenFromSearch(search: string): string | null {
  const token = new URLSearchParams(search).get('token');
  return token && token.trim().length > 0 ? token : null;
}

/**
 * What the login page owes the visitor after a magic-link request.
 *
 * `sent === false` is the API saying it has no transport, so the honest answer
 * is "nothing was sent" rather than "check your inbox". A dev link needs its own
 * branch because it is a delivery in the response body, not an email.
 */
export type MagicLinkNotice =
  { kind: 'dev_link'; link: string } | { kind: 'sent' } | { kind: 'no_transport' };

export function magicLinkNotice(
  response: Pick<MagicLinkResponse, 'sent' | 'link'>,
): MagicLinkNotice {
  if (response.link) return { kind: 'dev_link', link: response.link };
  return response.sent ? { kind: 'sent' } : { kind: 'no_transport' };
}

/**
 * What a failed `/auth/me` probe means for the session.
 *
 * Only a 401 proves there is no session. Every other failure — API down, 502
 * from a proxy, unreadable payload — says nothing about the user's cookie, so
 * treating it as signed out would throw a valid session away. An abort is the
 * caller unmounting and carries no meaning at all.
 */
export function sessionProbeOutcome(error: unknown): 'signed_out' | 'aborted' | 'unavailable' {
  if (isAbortError(error)) return 'aborted';
  if (error instanceof ApiError && error.status === 401) return 'signed_out';
  return 'unavailable';
}
