import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Everything inside `container` the keyboard can reach, in tab order. */
export function focusableIn(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => element.getClientRects().length > 0,
  );
}

/**
 * Where Tab has to go, or null when the browser's own move stays inside.
 *
 * Wrapping happens at both ends, and also when focus already escaped (a click
 * on the backdrop, or a focused node that was re-rendered away): otherwise one
 * Tab from the page behind lands in the sidebar again. With nothing focusable
 * inside, the container itself takes the focus so Tab cannot leave at all.
 */
export function nextFocusTarget(
  container: HTMLElement,
  active: Element | null,
  shiftKey: boolean,
): HTMLElement | null {
  const focusable = focusableIn(container);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) return container;

  const inside = active !== null && container.contains(active);
  if (shiftKey) {
    return active === first || !inside ? last : null;
  }
  return active === last || !inside ? first : null;
}

/**
 * Return focus to the element that opened the overlay — but only while it is
 * still in the document. A table row can be replaced by an API refresh while
 * the dialog is open, and focusing a detached node silently drops focus to
 * `<body>`.
 */
export function restoreFocus(target: HTMLElement | null): void {
  if (target && document.contains(target)) target.focus();
}

/**
 * Focus the preferred element, or the first one that actually accepts focus.
 *
 * The preference can refuse: a confirm dialog re-opened while its confirm
 * request is still in flight renders a disabled cancel button, and focusing a
 * disabled control is a no-op that leaves focus on the page behind.
 */
export function focusInitial(container: HTMLElement, preferred: HTMLElement | null): void {
  const candidates = preferred ? [preferred, ...focusableIn(container)] : focusableIn(container);
  for (const candidate of candidates) {
    candidate.focus();
    if (container.contains(document.activeElement)) return;
  }
  container.focus();
}

export interface FocusTrapOptions {
  /** Called on Escape; omit to leave Escape to the rest of the UI. */
  onEscape?: () => void;
  /** Ignore Escape while this is true (a request is in flight). */
  escapeDisabled?: boolean;
  /** Element to focus on open; defaults to the first focusable child. */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * Keep keyboard focus inside an open overlay.
 *
 * `aria-modal="true"` alone hides nothing from the tab order, so the overlay
 * needs three guarantees itself: focus starts inside, Tab and Shift+Tab wrap
 * within the container, and focus returns to whatever was focused before.
 *
 * Callers pass inline callbacks that change identity on every render, so the
 * effect depends on `open` alone and reads the latest callbacks through a ref.
 * Re-running it per render would move focus on every keystroke.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  open: boolean,
  options: FocusTrapOptions = {},
): void {
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusInitial(container, latest.current.initialFocusRef?.current ?? null);

    function onKeyDown(event: KeyboardEvent): void {
      const current = containerRef.current;
      if (!current) return;

      if (event.key === 'Escape') {
        const { onEscape, escapeDisabled } = latest.current;
        if (escapeDisabled || !onEscape) return;
        event.preventDefault();
        onEscape();
        return;
      }
      if (event.key !== 'Tab') return;

      const target = nextFocusTarget(current, document.activeElement, event.shiftKey);
      if (!target) return; // an interior move: let the browser handle it
      event.preventDefault();
      target.focus();
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      restoreFocus(previouslyFocused);
    };
  }, [containerRef, open]);
}
