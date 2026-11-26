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
  {
    version: 2,
    /**
     * Password sign-in replaced the magic link. The column is nullable so an
     * installation that still carries a passwordless operator can be claimed
     * by the first setup; every new account is created with a hash.
     *
     * `magic_links` stays as it is: migration 1 is immutable, and dropping a
     * table deletes rows we do not own. The table is no longer written or read.
     */
    up(db: Db): void {
      db.exec('alter table users add column password_hash text');
    },
  },
];
