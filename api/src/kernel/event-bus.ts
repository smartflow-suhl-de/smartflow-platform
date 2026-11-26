import type { PlatformEvents, EventName } from '../shared/events.ts';
import { newId } from './ids.ts';
import type { Db } from './db.ts';

/**
 * The platform event log. Plugins emit a typed event instead of importing each
 * other; the kernel persists every event and calls the listeners registered in
 * this process. Persistence is what makes the log an audit trail, listeners are
 * best effort — a failing listener never fails the request that emitted.
 */
export class EventBus {
  readonly #db: Db;
  readonly #now: () => Date;
  readonly #onError: (error: unknown, event: string) => void;
  readonly #listeners = new Map<string, ((payload: never) => void | Promise<void>)[]>();
  /** Last timestamp stored, so events of one millisecond keep their order. */
  #lastCreatedMs = 0;

  constructor(db: Db, now: () => Date, onError: (error: unknown, event: string) => void) {
    this.#db = db;
    this.#now = now;
    this.#onError = onError;
  }

  /**
   * `created_at` is the log's only sort key, so it must be strict: several
   * events of one request can fall into the same millisecond. One millisecond
   * of separation keeps them ordered without a second column. A clock that
   * jumps backwards must not reorder the log either.
   */
  #createdAt(): string {
    const nowMs = this.#now().getTime();
    this.#lastCreatedMs = nowMs > this.#lastCreatedMs ? nowMs : this.#lastCreatedMs + 1;
    return new Date(this.#lastCreatedMs).toISOString();
  }

  emit<K extends EventName>(name: K, payload: PlatformEvents[K]): void {
    this.#db
      .prepare('insert into events (id, name, payload, created_at) values (?, ?, ?, ?)')
      .run(newId('evt'), name, JSON.stringify(payload), this.#createdAt());

    for (const handler of this.#listeners.get(name) ?? []) {
      void Promise.resolve(handler(payload as never)).catch((error: unknown) => {
        this.#onError(error, name);
      });
    }
  }

  on<K extends EventName>(
    name: K,
    handler: (payload: PlatformEvents[K]) => void | Promise<void>,
  ): void {
    const list = this.#listeners.get(name) ?? [];
    list.push(handler as (payload: never) => void | Promise<void>);
    this.#listeners.set(name, list);
  }
}
