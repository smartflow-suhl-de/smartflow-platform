import type { PluginContext } from '../../kernel/context.ts';
import type { SecretBox } from '../../kernel/secrets.ts';
import { AppError } from '../../kernel/errors.ts';
import { newId } from '../../kernel/ids.ts';
import { decodeCursor, encodeCursor } from '../../kernel/cursor.ts';
import { fetchInbox } from './imap.ts';
import { getInboxSync, getMailbox, type InboxRow } from './store.ts';

const SYNC_THROTTLE_MS = 60_000;

interface InboxListItem {
  id: string;
  from_address: string;
  from_name: string | null;
  subject: string;
  snippet: string;
  received_at: string;
  unread: boolean;
  attachment_count: number;
}

function toListItem(row: InboxRow): InboxListItem {
  return {
    id: row.id,
    from_address: row.from_address,
    from_name: row.from_name,
    subject: row.subject,
    snippet: row.snippet,
    received_at: row.received_at,
    unread: row.unread === 1,
    attachment_count: row.attachment_count,
  };
}

/**
 * One sync at a time, at most once a minute. Both limits live in this process;
 * the deployment is a single process by design, so a database flag would only
 * add a stale-lock failure mode.
 */
export function createSync(ctx: PluginContext, box: SecretBox) {
  let running = false;
  let lastStart = 0;

  const run = async (retentionDays: number, now: Date): Promise<{ added: number }> => {
    const mailbox = getMailbox(ctx.db);
    if (!mailbox.host || !mailbox.username || !mailbox.password_sealed) {
      throw new AppError('email_inbox_not_connected', 'No mailbox is configured.', 409);
    }
    const password = box.open(mailbox.password_sealed);
    const state = getInboxSync(ctx.db);
    const fetched = await fetchInbox(mailbox, password, {
      uidValidity: state.uid_validity,
      uidNext: state.uid_next,
    });

    const retainedUntil = new Date(
      now.getTime() + retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const insert = ctx.db.prepare(
      `insert into email_inbox_message
         (id, uid_validity, uid, message_id, from_address, from_name, subject, snippet,
          text_body, html_body, received_at, unread, attachment_count, retained_until)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (uid_validity, uid) do nothing`,
    );
    let added = 0;
    ctx.db.transaction(() => {
      for (const message of fetched.messages) {
        const result = insert.run(
          newId('msg'),
          fetched.uidValidity,
          message.uid,
          message.messageId,
          message.fromAddress,
          message.fromName,
          message.subject,
          message.snippet,
          message.textBody,
          message.htmlBody,
          message.receivedAt,
          message.unread ? 1 : 0,
          message.attachmentCount,
          retainedUntil,
        );
        added += result.changes;
      }
      ctx.db
        .prepare(
          `update email_inbox_sync
              set last_sync_at = ?, last_error_code = null, uid_validity = ?, uid_next = ?
            where id = 1`,
        )
        .run(now.toISOString(), fetched.uidValidity, fetched.uidNext);
    })();
    return { added };
  };

  return {
    isRunning: () => running,
    lastStart: () => lastStart,
    async sync(retentionDays: number, now: Date): Promise<{ added: number }> {
      if (running) throw new AppError('email_sync_running', 'A sync is already running.', 409);
      if (Date.now() - lastStart < SYNC_THROTTLE_MS) {
        throw new AppError('email_sync_throttled', 'Please wait before syncing again.', 429);
      }
      running = true;
      lastStart = Date.now();
      try {
        return await run(retentionDays, now);
      } catch (error) {
        const code = error instanceof AppError ? error.code : 'email_inbox_unreachable';
        ctx.db.prepare('update email_inbox_sync set last_error_code = ? where id = 1').run(code);
        if (error instanceof AppError) throw error;
        ctx.log.warn({ code }, 'email inbox sync failed');
        throw new AppError(code, 'The mailbox could not be reached.', 502);
      } finally {
        running = false;
      }
    },
  };
}

export type MailboxSync = ReturnType<typeof createSync>;

export function registerInbox(ctx: PluginContext, sync: MailboxSync, retentionDays: () => number): void {
  const { app, db, now } = ctx;
  const operator = app.requireRole('operator');

  app.get(
    '/email/inbox',
    { preHandler: operator, schema: { summary: 'List received mail', tags: ['email'] } },
    async (request) => {
      const query = request.query as {
        unread?: string;
        q?: string;
        cursor?: string;
        limit?: string;
      };
      const where: string[] = [];
      const params: unknown[] = [];
      if (query.unread === 'true') where.push('unread = 1');
      if (query.q) {
        where.push("(subject like ? escape '\\' or from_address like ? escape '\\' or snippet like ? escape '\\')");
        const needle = `%${query.q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
        params.push(needle, needle, needle);
      }
      const total = (
        db
          .prepare(
            `select count(*) as n from email_inbox_message${where.length > 0 ? ` where ${where.join(' and ')}` : ''}`,
          )
          .get(...params) as { n: number }
      ).n;

      const pageWhere = [...where];
      const pageParams = [...params];
      if (query.cursor) {
        const cursor = decodeCursor(query.cursor);
        if (!cursor) throw new AppError('invalid_cursor', 'The cursor is invalid.', 400);
        pageWhere.push('(received_at < ? or (received_at = ? and id < ?))');
        pageParams.push(cursor.created_at, cursor.created_at, cursor.id);
      }
      const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '25', 10) || 25));
      const rows = db
        .prepare(
          `select * from email_inbox_message
            ${pageWhere.length > 0 ? `where ${pageWhere.join(' and ')}` : ''}
            order by received_at desc, id desc limit ?`,
        )
        .all(...pageParams, limit) as InboxRow[];
      const last = rows.at(-1);
      return {
        items: rows.map(toListItem),
        total,
        nextCursor:
          rows.length === limit && last
            ? encodeCursor({ created_at: last.received_at, id: last.id })
            : null,
      };
    },
  );

  app.get(
    '/email/inbox/status',
    { preHandler: operator, schema: { summary: 'Inbox connection state', tags: ['email'] } },
    async () => {
      const state = getInboxSync(db);
      const mailbox = getMailbox(db);
      const unread = (
        db.prepare('select count(*) as n from email_inbox_message where unread = 1').get() as {
          n: number;
        }
      ).n;
      const stored = (
        db.prepare("select count(*) as n from email_inbox_message").get() as { n: number }
      ).n;
      return {
        connected: Boolean(mailbox.host && mailbox.username && mailbox.password_sealed),
        address: mailbox.address,
        last_sync_at: state.last_sync_at,
        last_error_code: state.last_error_code,
        uid_validity: state.uid_validity,
        syncing: sync.isRunning(),
        unread,
        stored,
      };
    },
  );

  app.post(
    '/email/inbox/sync',
    { preHandler: operator, schema: { summary: 'Pull new mail once', tags: ['email'] } },
    async (_request, reply) => {
      const result = await sync.sync(retentionDays(), now());
      reply.code(202);
      return { added: result.added };
    },
  );

  app.get(
    '/email/inbox/:id',
    { preHandler: operator, schema: { summary: 'Read one message', tags: ['email'] } },
    async (request) => {
      const { id } = request.params as { id: string };
      const row = db
        .prepare('select * from email_inbox_message where id = ?')
        .get(id) as InboxRow | undefined;
      if (!row) throw new AppError('not_found', 'Message not found.', 404);
      return {
        ...toListItem(row),
        message_id: row.message_id,
        text_body: row.text_body,
        html_body: row.html_body,
        retained_until: row.retained_until,
      };
    },
  );

  app.patch(
    '/email/inbox/:id',
    { preHandler: operator, schema: { summary: 'Mark a message read or unread', tags: ['email'] } },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { read?: unknown };
      if (typeof body.read !== 'boolean') {
        throw new AppError('validation_failed', 'Send read: true or false.', 422);
      }
      // Local only: the server-side \Seen flag is never written.
      const result = db
        .prepare('update email_inbox_message set unread = ? where id = ?')
        .run(body.read ? 0 : 1, id);
      if (result.changes === 0) throw new AppError('not_found', 'Message not found.', 404);
      return { id, read: body.read };
    },
  );

}