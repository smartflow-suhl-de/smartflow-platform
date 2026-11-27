import type { Migration } from '../../kernel/db.ts';
import type { Db } from '../../kernel/db.ts';

export type TlsMode = 'starttls' | 'tls';
export type DeliveryStatus = 'queued' | 'sending' | 'sent' | 'failed';

export interface EmailSettingsRow {
  id: number;
  host: string;
  port: number;
  tls_mode: TlsMode;
  username: string;
  password_sealed: string | null;
  from_address: string;
  from_name: string;
  reply_to: string | null;
  retention_days: number;
  updated_at: string;
  updated_by: string;
}

export interface MailboxRow {
  id: number;
  host: string;
  port: number;
  tls_mode: TlsMode;
  username: string;
  password_sealed: string | null;
  address: string;
  updated_at: string;
}

export interface OutboxRow {
  id: string;
  tenant_id: string | null;
  to_address: string | null;
  to_name: string | null;
  subject: string | null;
  text_body: string | null;
  html_body: string | null;
  reply_to: string | null;
  dedupe_key: string | null;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: string;
  last_error_code: string | null;
  permanent_failure: number;
  created_at: string;
  sent_at: string | null;
  redacted_at: string | null;
}

export interface InboxRow {
  id: string;
  uid_validity: number;
  uid: number;
  message_id: string | null;
  from_address: string;
  from_name: string | null;
  subject: string;
  snippet: string;
  text_body: string | null;
  html_body: string | null;
  received_at: string;
  unread: number;
  attachment_count: number;
  retained_until: string;
}

export interface InboxSyncRow {
  id: number;
  last_sync_at: string | null;
  last_error_code: string | null;
  uid_validity: number | null;
  uid_next: number | null;
}

/**
 * The platform database holds one settings row, the delivery queue and the
 * read-only mailbox copy. There is no tenant column on mail: stage 1–2 is a
 * single global sender per the agreed contract.
 */
export const emailMigrations: Migration[] = [
  {
    version: 1,
    up(db: Db): void {
      db.exec(`
        create table email_settings (
          id integer primary key check (id = 1),
          host text not null default '',
          port integer not null default 587 check (port between 1 and 65535),
          tls_mode text not null default 'starttls' check (tls_mode in ('starttls','tls')),
          username text not null default '',
          password_sealed text,
          from_address text not null default '',
          from_name text not null default 'SmartFlow',
          reply_to text,
          retention_days integer not null default 90
            check (retention_days between 7 and 3650),
          updated_at text not null default '',
          updated_by text not null default ''
        );
        insert into email_settings (id) values (1);

        create table email_mailbox (
          id integer primary key check (id = 1),
          host text not null default '',
          port integer not null default 993 check (port between 1 and 65535),
          tls_mode text not null default 'tls' check (tls_mode in ('starttls','tls')),
          username text not null default '',
          password_sealed text,
          address text not null default '',
          updated_at text not null default ''
        );
        insert into email_mailbox (id) values (1);

        create table email_outbox (
          id text primary key,
          tenant_id text,
          to_address text,
          to_name text,
          subject text,
          text_body text,
          html_body text,
          reply_to text,
          dedupe_key text,
          status text not null check (status in ('queued','sending','sent','failed')),
          attempts integer not null default 0,
          next_attempt_at text not null,
          last_error_code text,
          permanent_failure integer not null default 0,
          created_at text not null,
          sent_at text,
          redacted_at text
        );
        create unique index email_outbox_platform_dedupe
          on email_outbox(dedupe_key) where tenant_id is null;
        create index email_outbox_delivery on email_outbox(status, next_attempt_at);
        create index email_outbox_created on email_outbox(created_at, id);

        create table email_inbox_message (
          id text primary key,
          uid_validity integer not null,
          uid integer not null,
          message_id text,
          from_address text not null,
          from_name text,
          subject text not null,
          snippet text not null,
          text_body text,
          html_body text,
          received_at text not null,
          unread integer not null default 1,
          attachment_count integer not null default 0,
          retained_until text not null,
          unique (uid_validity, uid)
        );
        create index email_inbox_received on email_inbox_message(received_at, id);
        create index email_inbox_unread on email_inbox_message(unread);
        create index email_inbox_retention on email_inbox_message(retained_until);

        create table email_inbox_sync (
          id integer primary key check (id = 1),
          last_sync_at text,
          last_error_code text,
          uid_validity integer,
          uid_next integer
        );
        insert into email_inbox_sync (id) values (1);

        create table email_retention_state (
          id integer primary key check (id = 1),
          last_run_at text,
          last_deleted integer not null default 0
        );
        insert into email_retention_state (id) values (1);
      `);
    },
  },
];

export function getSettings(db: Db): EmailSettingsRow {
  return db.prepare('select * from email_settings where id = 1').get() as EmailSettingsRow;
}

export function getMailbox(db: Db): MailboxRow {
  return db.prepare('select * from email_mailbox where id = 1').get() as MailboxRow;
}

export function getInboxSync(db: Db): InboxSyncRow {
  return db.prepare('select * from email_inbox_sync where id = 1').get() as InboxSyncRow;
}

export interface PublicSender {
  name: string;
  address: string;
  reply_to: string | null;
}

export interface PublicTransport {
  host: string;
  port: number;
  tls_mode: TlsMode;
  username: string;
  password_set: boolean;
}

/** What a client may see: never the password or its sealed form. */
export function publicSender(row: EmailSettingsRow): PublicSender {
  return { name: row.from_name, address: row.from_address, reply_to: row.reply_to };
}

export function publicTransport(row: EmailSettingsRow): PublicTransport {
  return {
    host: row.host,
    port: row.port,
    tls_mode: row.tls_mode,
    username: row.username,
    password_set: Boolean(row.password_sealed),
  };
}

export function isConfigured(row: EmailSettingsRow): boolean {
  return Boolean(row.host && row.port && row.username && row.from_address && row.password_sealed);
}