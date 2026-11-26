import {
  createElement,
  useEffect,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
} from 'react';

export interface RouteLocation {
  pathname: string;
  search: string;
}

/** Read the current location in the shape the app routes on. */
export function readLocation(): RouteLocation {
  return {
    pathname: window.location.pathname || '/',
    search: window.location.search || '',
  };
}

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Subscribe to in-app navigations and browser back/forward.
 *
 * Kept separate from `useRoute` so the wiring can be tested without a React
 * render pass: the hook is a thin wrapper around this.
 */
export function subscribeToLocation(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  // Resolve against the current document, not the origin: a relative target
  // such as `?create=1` must stay on the current path.
  const url = new URL(to, window.location.href);
  const next = `${url.pathname}${url.search}`;
  const current = `${window.location.pathname}${window.location.search}`;
  if (next === current) return;

  if (options.replace) {
    window.history.replaceState({}, '', next);
  } else {
    window.history.pushState({}, '', next);
  }
  notify();
  // A new page starts at the top. `replace` keeps the scroll position, and
  // browser back/forward never reaches this function (`popstate` restores the
  // position itself).
  if (!options.replace) window.scrollTo(0, 0);
}

export function useRoute(): RouteLocation {
  const [route, setRoute] = useState<RouteLocation>(readLocation);

  useEffect(() => {
    const sync = () => setRoute(readLocation());
    return subscribeToLocation(sync);
  }, []);

  return route;
}

export interface AppLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string;
  replace?: boolean;
}

/**
 * True when the click should be handled by the SPA router. Modified clicks
 * (new tab, download, middle button) must keep the browser's default.
 */
export function isPlainLeftClick(
  event: Pick<
    MouseEvent,
    'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'defaultPrevented'
  >,
): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

export function AppLink({ to, replace, onClick, ...props }: AppLinkProps) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>): void {
    onClick?.(event);
    if (!isPlainLeftClick(event)) {
      return;
    }
    event.preventDefault();
    navigate(to, { replace });
  }

  return createElement('a', { ...props, href: to, onClick: handleClick });
}
