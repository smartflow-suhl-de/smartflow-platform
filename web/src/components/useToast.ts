import { createContext, useContext } from 'react';
import type { ToastRecord, ToastTone } from '../lib/toast';

export interface ToastOptions {
  tone?: ToastTone;
  durationMs?: number;
}

export type ShowToast = (message: string, options?: ToastOptions) => void;

/** State and actions shared by the provider, the region and every caller. */
export interface ToastApi {
  toasts: ToastRecord[];
  showToast: ShowToast;
  dismiss: (id: number) => void;
}

export const ToastContext = createContext<ToastApi | null>(null);

/** The whole store. Used by `ToastRegion`; pages use `useToast` instead. */
export function useToastApi(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside ToastProvider');
  return api;
}

/** Shows one toast. Throws outside the provider, which is a wiring bug. */
export function useToast(): ShowToast {
  return useToastApi().showToast;
}
