/**
 * Queue rules for the app-wide toast stack.
 *
 * Kept free of React so the behaviour (order, cap, leaving state) is testable
 * in the node:test setup, which has no DOM.
 */
export type ToastTone = 'good' | 'info' | 'bad';

export interface ToastRecord {
  id: number;
  message: string;
  tone: ToastTone;
  durationMs: number;
  /** True while the exit animation runs; the record is removed afterwards. */
  leaving: boolean;
}

/** How long a toast stays before it fades out on its own. */
export const TOAST_DURATION_MS = 8000;

/** Must match the `sf-toast-out` animation duration in index.css. */
export const TOAST_EXIT_MS = 180;

/** More than this at once would cover the page; the oldest makes room. */
export const TOAST_LIMIT = 4;

export function addToast(toasts: readonly ToastRecord[], toast: ToastRecord): ToastRecord[] {
  return [...toasts, toast].slice(-TOAST_LIMIT);
}

/** Idempotent: a second close click must not schedule a second removal pass. */
export function markToastLeaving(toasts: readonly ToastRecord[], id: number): ToastRecord[] {
  return toasts.map((toast) =>
    toast.id === id && !toast.leaving ? { ...toast, leaving: true } : toast,
  );
}

export function removeToast(toasts: readonly ToastRecord[], id: number): ToastRecord[] {
  return toasts.filter((toast) => toast.id !== id);
}
