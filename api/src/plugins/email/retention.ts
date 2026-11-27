import type { Db } from '../../kernel/db.ts';
import type { FastifyBaseLogger } from 'fastify';
import type { EmailSettingsRow } from './store.ts';
import { getSettings } from './store.ts';

const BATCH = 500;

function cutoff(days: number, at: Date): string {
  return new Date(at.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Rows a run under the current retention would still delete. */
export function pendingRows(db: Db, settings: EmailSettingsRow, now: Date): number {
  const limit = cutoff(settings.retention_days, now);
  const outbox = (
    db
      .prepare(
        'select count(*) as n from email_outbox where created_at < ? and redacted_at is null',
      )
      .get(limit) as { n: number }
  ).n;
  const inbox = (
    db
      .prepare('select count(*) as n from email_inbox_message where received_at < ?')
      .get(limit) as { n: number }
  ).n;
  return outbox + inbox;
}

export interface RetentionResult {
  deleted: number;
  remaining: number;
}

/**
 * Redact the body of old outbound mail and delete old mailbox copies. Rows are
 * never removed from the outbox: the delivery statistic stays, the content does
 * not. The mailbox copy can go entirely because the server keeps the original.
 */
export function runRetention(
  db: Db,
  log: FastifyBaseLogger,
  now: Date,
  budgetMs: number | null,
): RetentionResult {
  const settings = getSettings(db);
  const limit = cutoff(settings.retention_days, now);
  const started = Date.now();
  let deleted = 0;
  let rounds = 0;

  for (;;) {
    rounds += 1;
    const outboxIds = db
      .prepare(
        'select id from email_outbox where created_at < ? and redacted_at is null limit ?',
      )
      .all(limit, BATCH) as Array<{ id: string }>;
    const inboxIds = db
      .prepare('select id from email_inbox_message where received_at < ? limit ?')
      .all(limit, BATCH) as Array<{ id: string }>;

    if (outboxIds.length === 0 && inboxIds.length === 0) break;

    const redact = db.prepare(
      `update email_outbox
          set to_address = null, to_name = null, subject = null, text_body = null,
              html_body = null, reply_to = null, redacted_at = ?
        where id = ?`,
    );
    const remove = db.prepare('delete from email_inbox_message where id = ?');
    const stamp = now.toISOString();
    db.transaction(() => {
      for (const row of outboxIds) redact.run(stamp, row.id);
      for (const row of inboxIds) remove.run(row.id);
    })();
    deleted += outboxIds.length + inboxIds.length;

    if (budgetMs !== null && Date.now() - started > budgetMs) break;
    if (rounds > 10_000) break;
  }

  db.prepare(
    'update email_retention_state set last_run_at = ?, last_deleted = ? where id = 1',
  ).run(now.toISOString(), deleted);
  log.info({ deleted }, 'email retention run finished');
  return { deleted, remaining: pendingRows(db, settings, now) };
}

export function lastRetentionRun(db: Db): string | null {
  const row = db
    .prepare('select last_run_at from email_retention_state where id = 1')
    .get() as { last_run_at: string | null };
  return row.last_run_at;
}

/** The daily sweep runs at 03:00 UTC; shortening runs immediately in the PUT. */
export function nextRetentionRun(now: Date): string {
  const next = new Date(now);
  next.setUTCHours(3, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}