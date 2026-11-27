import type { PluginContext } from '../../kernel/context.ts';
import type { SecretBox } from '../../kernel/secrets.ts';
import type { Db } from '../../kernel/db.ts';
import { AppError } from '../../kernel/errors.ts';
import { FieldError } from '../../shared/contract.ts';
import { newId } from '../../kernel/ids.ts';
import { decodeCursor, encodeCursor } from '../../kernel/cursor.ts';
import {
  getSettings,
  isConfigured,
  type DeliveryStatus,
  type OutboxRow,
} from './store.ts';
import { classifySendError, sendMail } from './transport.ts';
import type { FastifyBaseLogger } from 'fastify';

const MAX_BODY = 100 * 1024;
const BACKOFF_MINUTES = [1, 5, 15, 60, 240];
const MAX_ATTEMPTS = 5;

export interface OutboxListItem {
  id: string;
  to_address: string | null;
  subject: string | null;
  status: DeliveryStatus;
  attempts: number;
  created_at: string;
  sent_at: string | null;
  last_error_code: string | null;
  permanent_failure: boolean;
}

function toListItem(row: OutboxRow): OutboxListItem {
  return {
    id: row.id,
    to_address: row.to_address,
    subject: row.subject,
    status: row.status,
    attempts: row.attempts,
    created_at: row.created_at,
    sent_at: row.sent_at,
    last_error_code: row.last_error_code,
    permanent_failure: row.permanent_failure === 1,
  };
}

function backoffAt(attempts: number, now: Date): string {
  const minutes = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)] ?? 240;
  const jitter = Math.floor(Math.random() * 30_000);
  return new Date(now.getTime() + minutes * 60_000 + jitter).toISOString();
}

/**
 * Claims one due row and sends it. Single-flight per process: the claim is a
 * conditional UPDATE, so a second tick cannot pick the same row.
 */
export async function deliverOne(
  db: Db,
  box: SecretBox,
  log: FastifyBaseLogger,
  now: Date,
): Promise<boolean> {
  const settings = getSettings(db);
  if (!isConfigured(settings) || !settings.password_sealed) return false;

  const stamp = now.toISOString();
  const row = db
    .prepare(
      `update email_outbox
          set status = 'sending'
        where id = (
          select id from email_outbox
           where status = 'queued' and next_attempt_at <= ?
           order by next_attempt_at, created_at
           limit 1
        )
        returning *`,
    )
    .get(stamp) as OutboxRow | undefined;
  if (!row) return false;

  try {
    const password = box.open(settings.password_sealed);
    await sendMail(settings, password, {
      to: row.to_address ?? '',
      toName: row.to_name,
      subject: row.subject ?? '',
      text: row.text_body,
      html: row.html_body,
      replyTo: row.reply_to,
    });
    db.prepare(
      `update email_outbox set status = 'sent', sent_at = ?, last_error_code = null where id = ?`,
    ).run(now.toISOString(), row.id);
    log.info({ emailId: row.id }, 'email sent');
    return true;
  } catch (error) {
    const failure =
      (error as Error).message.includes('unable to authenticate data') ||
      (error as Error).message.includes('Unsupported state')
        ? { code: 'email_secret_unreadable', permanent: true }
        : classifySendError(error);
    const attempts = row.attempts + 1;
    const exhausted = failure.permanent || attempts >= MAX_ATTEMPTS;
    db.prepare(
      `update email_outbox
          set status = ?, attempts = ?, next_attempt_at = ?, last_error_code = ?,
              permanent_failure = ?
        where id = ?`,
    ).run(
      exhausted ? 'failed' : 'queued',
      attempts,
      backoffAt(attempts, now),
      failure.code,
      exhausted ? 1 : 0,
      row.id,
    );
    // The SMTP text stays out of the log: it can carry the recipient address.
    log.warn({ emailId: row.id, code: failure.code, attempts }, 'email delivery failed');
    return true;
  }
}

export function startWorker(ctx: PluginContext, box: SecretBox): () => void {
  let running = false;
  let stopped = false;

  // A crash in `sending` would otherwise strand the row forever.
  ctx.db
    .prepare(
      `update email_outbox set status = 'queued'
        where status = 'sending' and created_at < ?`,
    )
    .run(new Date(ctx.now().getTime() - 10 * 60_000).toISOString());

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      // Drain a few rows per tick, then wait: a burst must not hold the loop.
      for (let i = 0; i < 5; i += 1) {
        const delivered = await deliverOne(ctx.db, box, ctx.log, ctx.now());
        if (!delivered) break;
      }
    } catch (error) {
      ctx.log.error({ err: error }, 'email worker failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), 5000);
  timer.unref();
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export function registerOutbox(ctx: PluginContext): void {
  const { app, db, now } = ctx;
  const operator = app.requireRole('operator');

  app.post(
    '/email/outbox',
    { preHandler: operator, schema: { summary: 'Queue an email', tags: ['email'] } },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const fields: Record<string, string> = {};
      const to = typeof body.to === 'string' ? body.to.trim() : '';
      const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
      const text = typeof body.text === 'string' ? body.text : undefined;
      const html = typeof body.html === 'string' ? body.html : undefined;
      const replyTo = typeof body.reply_to === 'string' ? body.reply_to.trim() : null;
      const dedupeKey = typeof body.dedupe_key === 'string' ? body.dedupe_key.trim() : null;

      if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(to) || /[\r\n]/.test(to)) {
        fields.to = 'Please enter a single valid email address.';
      }
      if (subject.length === 0 || subject.length > 200 || /[\r\n]/.test(subject)) {
        fields.subject = 'Please enter 1 to 200 characters without line breaks.';
      }
      if (!text && !html) fields.text = 'Text or HTML is required.';
      if (text && Buffer.byteLength(text, 'utf8') > MAX_BODY) fields.text = 'At most 100 KB.';
      if (html && Buffer.byteLength(html, 'utf8') > MAX_BODY) fields.html = 'At most 100 KB.';
      if (replyTo && (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(replyTo) || /[\r\n]/.test(replyTo))) {
        fields.reply_to = 'Please enter a single valid email address.';
      }
      if (dedupeKey && dedupeKey.length > 80) fields.dedupe_key = 'At most 80 characters.';
      if (Object.keys(fields).length > 0) throw new FieldError(fields);

      if (dedupeKey) {
        const existing = db
          .prepare(
            'select id, status from email_outbox where tenant_id is null and dedupe_key = ?',
          )
          .get(dedupeKey) as { id: string; status: DeliveryStatus } | undefined;
        if (existing) {
          reply.code(200);
          return { id: existing.id, status: existing.status };
        }
      }

      const settings = getSettings(db);
      if (!isConfigured(settings)) {
        throw new AppError('email_not_configured', 'The mail settings are incomplete.', 409);
      }

      const stamp = now().toISOString();
      const id = newId('eml');
      db.prepare(
        `insert into email_outbox
           (id, tenant_id, to_address, to_name, subject, text_body, html_body, reply_to,
            dedupe_key, status, attempts, next_attempt_at, created_at)
         values (?, null, ?, null, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
      ).run(id, to, subject, text ?? null, html ?? null, replyTo, dedupeKey, stamp, stamp);

      reply.code(202);
      return { id, status: 'queued' };
    },
  );

  app.get(
    '/email/outbox',
    { preHandler: operator, schema: { summary: 'List queued and sent mail', tags: ['email'] } },
    async (request) => {
      const query = request.query as { status?: string; cursor?: string; limit?: string };
      const statuses: DeliveryStatus[] = ['queued', 'sending', 'sent', 'failed'];
      const where: string[] = [];
      const params: unknown[] = [];
      if (query.status) {
        if (!statuses.includes(query.status as DeliveryStatus)) {
          throw new AppError('validation_failed', 'Unknown status filter.', 422);
        }
        where.push('status = ?');
        params.push(query.status);
      }
      const total = (
        db
          .prepare(
            `select count(*) as n from email_outbox${where.length > 0 ? ` where ${where.join(' and ')}` : ''}`,
          )
          .get(...params) as { n: number }
      ).n;

      const pageWhere = [...where];
      const pageParams = [...params];
      if (query.cursor) {
        const cursor = decodeCursor(query.cursor);
        if (!cursor) throw new AppError('invalid_cursor', 'The cursor is invalid.', 400);
        pageWhere.push('(created_at < ? or (created_at = ? and id < ?))');
        pageParams.push(cursor.created_at, cursor.created_at, cursor.id);
      }
      const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '25', 10) || 25));
      const rows = db
        .prepare(
          `select * from email_outbox
            ${pageWhere.length > 0 ? `where ${pageWhere.join(' and ')}` : ''}
            order by created_at desc, id desc limit ?`,
        )
        .all(...pageParams, limit) as OutboxRow[];
      const last = rows.at(-1);
      return {
        items: rows.map(toListItem),
        total,
        nextCursor:
          rows.length === limit && last ? encodeCursor({ created_at: last.created_at, id: last.id }) : null,
      };
    },
  );

  app.get(
    '/email/outbox/:id',
    { preHandler: operator, schema: { summary: 'Read one email', tags: ['email'] } },
    async (request) => {
      const { id } = request.params as { id: string };
      const row = db.prepare('select * from email_outbox where id = ?').get(id) as OutboxRow | undefined;
      if (!row) throw new AppError('not_found', 'Email not found.', 404);
      return {
        ...toListItem(row),
        text_body: row.text_body,
        html_body: row.html_body,
        reply_to: row.reply_to,
        next_attempt_at: row.next_attempt_at,
        redacted_at: row.redacted_at,
      };
    },
  );

  app.post(
    '/email/outbox/:id/retry',
    { preHandler: operator, schema: { summary: 'Retry a failed email', tags: ['email'] } },
    async (request) => {
      const { id } = request.params as { id: string };
      const row = db.prepare('select * from email_outbox where id = ?').get(id) as OutboxRow | undefined;
      if (!row) throw new AppError('not_found', 'Email not found.', 404);
      if (row.status !== 'failed' || row.permanent_failure === 1) {
        throw new AppError('invalid_state', 'Only a retryable failure can be retried.', 409);
      }
      db.prepare(
        `update email_outbox
            set status = 'queued', attempts = 0, next_attempt_at = ?, last_error_code = null
          where id = ?`,
      ).run(now().toISOString(), id);
      return { id, status: 'queued' };
    },
  );
}