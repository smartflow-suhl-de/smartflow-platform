import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Db = Database.Database;

export interface Migration {
  version: number;
  up: (db: Db) => void;
}

/**
 * One database per customer, plus the platform database.
 *
 * `pragma` choices: WAL for concurrent reads while a worker writes, `foreign_keys`
 * so a broken relation fails loudly, `busy_timeout` so a short write lock does not
 * throw in the middle of a request.
 */
export function openDatabase(file: string): Db {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  return db;
}

/** Tenant databases live next to the platform database, one file per tenant id. */
export function tenantDatabaseFile(dataDir: string, tenantId: string): string {
  return join(dataDir, 'tenants', `${tenantId}.sqlite`);
}

/**
 * Applies pending migrations in order, each in its own transaction. Returns the
 * version now in place. Safe to call on every start: already-applied versions
 * are skipped.
 *
 * Versions are tracked per `scope` — the kernel, each plugin and each tenant
 * database — because every scope numbers its own migrations from 1. Without the
 * scope, a plugin migration would be skipped as soon as the platform had one.
 */
export function migrate(
  db: Db,
  migrations: Migration[],
  scope = 'platform',
): { version: number; applied: number[] } {
  db.exec(`
    create table if not exists schema_version (
      scope text not null,
      version integer not null,
      applied_at text not null,
      primary key (scope, version)
    )
  `);
  const row = db
    .prepare('select max(version) as version from schema_version where scope = ?')
    .get(scope) as { version: number | null };
  const current = row.version ?? 0;
  const applied: number[] = [];

  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      migration.up(db);
      db.prepare('insert into schema_version (scope, version, applied_at) values (?, ?, ?)').run(
        scope,
        migration.version,
        new Date().toISOString(),
      );
    })();
    applied.push(migration.version);
  }

  return { version: applied.at(-1) ?? current, applied };
}
