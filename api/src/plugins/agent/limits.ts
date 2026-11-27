import { AppError } from '../../kernel/errors.ts';

/**
 * Questions per operator per minute and per day, in memory.
 *
 * An in-memory counter resets with the process; that is the honest limit for
 * a single-operator platform and costs no table. It exists to cap provider
 * spend, not to police a user.
 */
export class RateLimiter {
  readonly #byUser = new Map<string, number[]>();
  readonly #perMinute: number;
  readonly #perDay: number;
  readonly #now: () => Date;

  constructor(perMinute: number, perDay: number, now: () => Date) {
    this.#perMinute = perMinute;
    this.#perDay = perDay;
    this.#now = now;
  }

  check(userId: string): void {
    const nowMs = this.#now().getTime();
    const dayAgo = nowMs - 24 * 60 * 60 * 1000;
    const minuteAgo = nowMs - 60 * 1000;

    const kept = (this.#byUser.get(userId) ?? []).filter((at) => at > dayAgo);
    const lastMinute = kept.filter((at) => at > minuteAgo).length;

    if (lastMinute >= this.#perMinute) {
      throw new AppError(
        'agent_rate_limited',
        'Too many questions in a short time. Please wait a moment.',
        429,
        { reason: 'per_minute' },
      );
    }
    if (kept.length >= this.#perDay) {
      throw new AppError('agent_rate_limited', 'The daily question limit is reached.', 429, {
        reason: 'per_day',
      });
    }

    kept.push(nowMs);
    this.#byUser.set(userId, kept);
  }
}
