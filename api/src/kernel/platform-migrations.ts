import type { Db } from './db.ts';

/**
 * Platform schema. Kernel tables only — identity, sessions and the audit log.
 * Business tables belong to plugins in their own migrations.
 */
export const platformMigrations = [
  {
    version: 1,
    up(db: Db): void {
      db.exec(`
        create table users (
          id text primary key,
          email text not null unique,
          name text not null,
          role text not null check (role in ('operator', 'tenant_admin', 'employee')),
          tenant_id text,
          created_at text not null
        );

        create table sessions (
          id text primary key,
          user_id text not null references users(id) on delete cascade,
          token_hash text not null unique,
          created_at text not null,
          expires_at text not null,
          last_seen_at text not null,
          user_agent text
        );
        create index sessions_user on sessions(user_id);

        create table magic_links (
          id text primary key,
          email text not null,
          token_hash text not null unique,
          created_at text not null,
          expires_at text not null,
          used_at text
        );
        create index magic_links_email on magic_links(email, created_at);

        create table events (
          id text primary key,
          name text not null,
          payload text not null,
          created_at text not null
        );
        create index events_name_created on events(name, created_at);
      `);
    },
  },
];
