import { ApiError, isAbortError } from './api';

/**
 * Credential rules shared by the login page and its tests.
 *
 * The server enforces the same bounds. Mirroring them in the client turns a
 * round trip into an immediate, localised message; the client never loosens
 * what the server accepts. Length is the only rule, but a password made only
 * of spaces is rejected as well.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

export type PasswordProblem = 'blank' | 'too_short' | 'too_long';

export function passwordProblem(password: string): PasswordProblem | null {
  if (password.trim().length === 0) return 'blank';
  if (password.length < PASSWORD_MIN_LENGTH) return 'too_short';
  if (password.length > PASSWORD_MAX_LENGTH) return 'too_long';
  return null;
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

/**
 * Synchronous single-flight guard. React state updates only apply after the
 * next render, so a double click or double Enter in the same tick would pass a
 * `submitting` state check twice. This flag flips immediately.
 */
export function createSubmitGuard(): {
  run: <T>(task: () => Promise<T>) => Promise<T | undefined>;
  readonly busy: boolean;
} {
  let busy = false;
  return {
    get busy() {
      return busy;
    },
    async run<T>(task: () => Promise<T>): Promise<T | undefined> {
      if (busy) return undefined;
      busy = true;
      try {
        return await task();
      } finally {
        busy = false;
      }
    },
  };
}
