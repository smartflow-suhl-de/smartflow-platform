import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CloseIcon } from './icons';
import { Button } from './ui';
import {
  TOAST_DURATION_MS,
  TOAST_EXIT_MS,
  addToast,
  markToastLeaving,
  removeToast,
  type ToastRecord,
} from '../lib/toast';
import { ToastContext, useToastApi, type ShowToast } from './useToast';

interface ToastItemProps {
  toast: ToastRecord;
  dismissLabel: string;
  onDismiss: (id: number) => void;
}

/**
 * One toast. The timer pauses while the pointer or keyboard focus is on it, so
 * a reader can finish and close it deliberately; leaving restarts the full
 * delay rather than losing the toast instantly.
 */
function ToastItem({ toast, dismissLabel, onDismiss }: ToastItemProps) {
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused || toast.leaving) return;
    const timer = window.setTimeout(() => onDismiss(toast.id), toast.durationMs);
    return () => window.clearTimeout(timer);
  }, [paused, toast.leaving, toast.id, toast.durationMs, onDismiss]);

  return (
    <div
      className={`sf-toast sf-toast-${toast.tone}${toast.leaving ? ' sf-toast-leaving' : ''}`}
      role="status"
      aria-atomic="true"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="sf-toast-message">{toast.message}</span>
      <Button
        variant="ghost"
        size="icon"
        className="sf-toast-close"
        aria-label={dismissLabel}
        onClick={() => onDismiss(toast.id)}
      >
        <CloseIcon size={14} />
      </Button>
    </div>
  );
}

export interface ToastProviderProps {
  children: ReactNode;
}

/**
 * Holds the toast queue. The visible stack is rendered by `ToastRegion` inside
 * the page's content container, so it follows the layout instead of floating
 * over the viewport; the provider stays above the shell to keep one queue.
 */
export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(1);
  const removalTimers = useRef<Set<number>>(new Set());

  const dismiss = useCallback((id: number) => {
    setToasts((current) => markToastLeaving(current, id));
    const timer = window.setTimeout(() => {
      removalTimers.current.delete(timer);
      setToasts((current) => removeToast(current, id));
    }, TOAST_EXIT_MS);
    removalTimers.current.add(timer);
  }, []);

  useEffect(
    () => () => {
      for (const timer of removalTimers.current) window.clearTimeout(timer);
      removalTimers.current.clear();
    },
    [],
  );

  const showToast = useCallback<ShowToast>((message, options = {}) => {
    const id = nextId.current++;
    setToasts((current) =>
      addToast(current, {
        id,
        message,
        tone: options.tone ?? 'good',
        durationMs: options.durationMs ?? TOAST_DURATION_MS,
        leaving: false,
      }),
    );
  }, []);

  const api = useMemo(() => ({ toasts, showToast, dismiss }), [toasts, showToast, dismiss]);

  return <ToastContext.Provider value={api}>{children}</ToastContext.Provider>;
}

export interface ToastRegionProps {
  /** Localised accessible name for every close button. */
  dismissLabel: string;
}

/**
 * The stack itself. It sits as the first child of the content container: in the
 * layout, right-aligned with the page padding, and sticky so a toast stays
 * visible while the page is scrolled.
 */
export function ToastRegion({ dismissLabel }: ToastRegionProps) {
  const { toasts, dismiss } = useToastApi();

  return (
    <div className="sf-toast-region">
      {toasts.map((toast) => (
        <ToastItem toast={toast} key={toast.id} dismissLabel={dismissLabel} onDismiss={dismiss} />
      ))}
    </div>
  );
}
