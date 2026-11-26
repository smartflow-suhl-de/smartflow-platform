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

function readLocation(): RouteLocation {
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

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  const url = new URL(to, window.location.origin);
  const next = `${url.pathname}${url.search}`;
  const current = `${window.location.pathname}${window.location.search}`;
  if (next === current) return;

  if (options.replace) {
    window.history.replaceState({}, '', next);
  } else {
    window.history.pushState({}, '', next);
  }
  notify();
}

export function useRoute(): RouteLocation {
  const [route, setRoute] = useState<RouteLocation>(readLocation);

  useEffect(() => {
    const sync = () => setRoute(readLocation());
    listeners.add(sync);
    window.addEventListener('popstate', sync);
    return () => {
      listeners.delete(sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);

  return route;
}

export interface AppLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string;
  replace?: boolean;
}

export function AppLink({ to, replace, onClick, ...props }: AppLinkProps) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>): void {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    navigate(to, { replace });
  }

  return createElement('a', { ...props, href: to, onClick: handleClick });
}
