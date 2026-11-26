import type { Role } from '../shared/contract.ts';
import type { PlatformEvents } from '../shared/events.ts';
import type { Config } from './config.ts';
import { hashToken, safeEqual } from './crypto.ts';
import type { Db } from './db.ts';
import { newId, token } from './ids.ts';

/** The auth service reports sign-ins and sign-outs; the kernel owns the log. */
export type AuthEvents = <K extends 'auth.signed_in' | 'auth.signed_out'>(
  name: K,
  payload: PlatformEvents[K],
) => void;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  tenantId: string | null;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  tenant_id: string | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  expires_at: string;
  token_hash: string;
}

function toUser(row: UserRow): SessionUser {
  return { id: row.id, email: row.email, name: row.name, role: row.role, tenantId: row.tenant_id };
}

export class AuthService {
  readonly #db: Db;
  readonly #config: Config;
  readonly #now: () => Date;
  readonly #emit: AuthEvents;

  constructor(
    db: Db,
    config: Config,
    now: () => Date = () => new Date(),
    emit: AuthEvents = () => undefined,
  ) {
    this.#db = db;
    this.#config = config;
    this.#now = now;
    this.#emit = emit;
  }

  /** The operator account is a platform fact, not a signup flow. */
  seedOperator(): SessionUser {
    const existing = this.#db
      .prepare('select id, email, name, role, tenant_id from users where email = ?')
      .get(this.#config.operator.email) as UserRow | undefined;
    if (existing) return toUser(existing);

    const row: UserRow = {
      id: newId('usr'),
      email: this.#config.operator.email,
      name: this.#config.operator.name,
      role: 'operator',
      tenant_id: null,
    };
    this.#db
      .prepare(
        'insert into users (id, email, name, role, tenant_id, created_at) values (?, ?, ?, ?, ?, ?)',
      )
      .run(row.id, row.email, row.name, row.role, row.tenant_id, this.#now().toISOString());
    return toUser(row);
  }

  /**
   * Creates a one-time link for the address, whether or not a user exists.
   * The caller answers identically in both cases (no account enumeration).
   */
  createMagicLink(email: string): { link: string; expiresAt: string } {
    const normalized = email.trim().toLowerCase();
    const plain = token(32);
    const createdAt = this.#now();
    const expiresAt = new Date(createdAt.getTime() + this.#config.magicLinkTtlSeconds * 1000);

    this.#db
      .prepare(
        'insert into magic_links (id, email, token_hash, created_at, expires_at) values (?, ?, ?, ?, ?)',
      )
      .run(
        newId('mlk'),
        normalized,
        hashToken(plain),
        createdAt.toISOString(),
        expiresAt.toISOString(),
      );

    const url = new URL('/login/confirm', this.#config.publicUrl);
    url.searchParams.set('token', plain);
    return { link: url.toString(), expiresAt: expiresAt.toISOString() };
  }

  /** Consumes the link and opens a session. Unknown, used or expired links fail alike. */
  consumeMagicLink(plain: string, userAgent?: string): { user: SessionUser; sessionToken: string } {
    const hash = hashToken(plain);
    const link = this.#db
      .prepare(
        'select id, email, token_hash, expires_at, used_at from magic_links where token_hash = ?',
      )
      .get(hash) as
      | {
          id: string;
          email: string;
          token_hash: string;
          expires_at: string;
          used_at: string | null;
        }
      | undefined;

    if (!link || !safeEqual(link.token_hash, hash) || link.used_at !== null) {
      throw new Error('invalid_link');
    }
    if (new Date(link.expires_at).getTime() <= this.#now().getTime()) {
      throw new Error('invalid_link');
    }

    const user = this.#db
      .prepare('select id, email, name, role, tenant_id from users where email = ?')
      .get(link.email) as UserRow | undefined;

    this.#db
      .prepare('update magic_links set used_at = ? where id = ?')
      .run(this.#now().toISOString(), link.id);

    if (!user) throw new Error('invalid_link');

    const session = this.createSession(user.id, userAgent);
    this.#emit('auth.signed_in', { userId: user.id, role: user.role });
    return { user: toUser(user), sessionToken: session };
  }

  createSession(userId: string, userAgent?: string): string {
    const plain = token(32);
    const now = this.#now();
    this.#db
      .prepare(
        `insert into sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at, user_agent)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId('ses'),
        userId,
        hashToken(plain),
        now.toISOString(),
        new Date(now.getTime() + this.#config.sessionTtlSeconds * 1000).toISOString(),
        now.toISOString(),
        userAgent ?? null,
      );
    return plain;
  }

  /** Resolves a session cookie. Expired sessions are deleted on sight. */
  userForToken(plain: string | undefined): SessionUser | null {
    if (!plain) return null;
    const hash = hashToken(plain);
    const session = this.#db
      .prepare('select id, user_id, expires_at, token_hash from sessions where token_hash = ?')
      .get(hash) as SessionRow | undefined;
    if (!session) return null;
    if (new Date(session.expires_at).getTime() <= this.#now().getTime()) {
      this.#db.prepare('delete from sessions where id = ?').run(session.id);
      return null;
    }
    const user = this.#db
      .prepare('select id, email, name, role, tenant_id from users where id = ?')
      .get(session.user_id) as UserRow | undefined;
    if (!user) return null;
    this.#db
      .prepare('update sessions set last_seen_at = ? where id = ?')
      .run(this.#now().toISOString(), session.id);
    return toUser(user);
  }

  destroySession(plain: string | undefined): void {
    if (!plain) return;
    const hash = hashToken(plain);
    const session = this.#db
      .prepare('select user_id from sessions where token_hash = ?')
      .get(hash) as { user_id: string } | undefined;
    if (!session) return;
    this.#db.prepare('delete from sessions where token_hash = ?').run(hash);
    this.#emit('auth.signed_out', { userId: session.user_id });
  }

  pruneSessions(): void {
    this.#db.prepare('delete from sessions where expires_at <= ?').run(this.#now().toISOString());
    this.#db
      .prepare('delete from magic_links where expires_at <= ?')
      .run(this.#now().toISOString());
  }
}
