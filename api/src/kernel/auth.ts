import type { Role } from '../shared/contract.ts';
import type { PlatformEvents } from '../shared/events.ts';
import type { Config } from './config.ts';
import { hashToken } from './crypto.ts';
import type { Db } from './db.ts';
import { newId, token } from './ids.ts';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password.ts';

/** The auth service reports sign-ins, sign-outs and the first-run setup; the kernel owns the log. */
export type AuthEvents = <K extends 'auth.setup_completed' | 'auth.signed_in' | 'auth.signed_out'>(
  name: K,
  payload: PlatformEvents[K],
) => void;

/** A sign-in result: the account and the plaintext session token for the cookie. */
export interface AuthResult {
  user: SessionUser;
  sessionToken: string;
}

/**
 * A predictable failure with a stable meaning for the route layer. The route
 * maps it to an HTTP error; the service never decides the status itself.
 */
export class AuthError extends Error {
  readonly code: 'setup_complete' | 'invalid_credentials' | 'email_taken';

  constructor(code: 'setup_complete' | 'invalid_credentials' | 'email_taken') {
    super(code);
    this.name = 'AuthError';
    this.code = code;
  }
}

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

interface UserWithPasswordRow extends UserRow {
  password_hash: string | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  expires_at: string;
  token_hash: string;
}

export interface SetupInput {
  email: string;
  name: string;
  password: string;
}

function toUser(row: UserRow): SessionUser {
  return { id: row.id, email: row.email, name: row.name, role: row.role, tenantId: row.tenant_id };
}

/** A duplicate key on `users.email` is the only constraint a setup can hit. */
function isEmailTaken(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
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

  /**
   * First-run setup is done exactly when no account can sign in yet. An
   * installation from the magic-link era has a passwordless operator row, so
   * counting rows would report "done" while nobody can get in; the password
   * column is the honest test.
   */
  setupRequired(): boolean {
    const row = this.#db
      .prepare('select 1 as present from users where password_hash is not null limit 1')
      .get();
    return row === undefined;
  }

  /**
   * Creates the first operator and opens its session. There is no public
   * signup: the route only calls this while `setupRequired()` is true, and the
   * check is repeated after the (awaited) hash so two parallel setups cannot
   * both create an account.
   */
  async setup(input: SetupInput, userAgent?: string): Promise<AuthResult> {
    if (!this.setupRequired()) throw new AuthError('setup_complete');

    const passwordHash = await hashPassword(input.password);

    if (!this.setupRequired()) throw new AuthError('setup_complete');

    const user = this.#claimOrCreateOperator(input, passwordHash);
    const sessionToken = this.createSession(user.id, userAgent);
    this.#emit('auth.setup_completed', { userId: user.id });
    this.#emit('auth.signed_in', { userId: user.id, role: user.role });
    return { user, sessionToken };
  }

  /**
   * The legacy operator seed left a row without a password. The first setup
   * takes that row over instead of leaving an unreachable account behind or
   * creating a second operator with a different address.
   */
  #claimOrCreateOperator(input: SetupInput, passwordHash: string): SessionUser {
    this.#db.exec('begin immediate');
    try {
      const user = this.#claimOrCreateOperatorTx(input, passwordHash);
      this.#db.exec('commit');
      return user;
    } catch (error) {
      this.#db.exec('rollback');
      throw error;
    }
  }

  #claimOrCreateOperatorTx(input: SetupInput, passwordHash: string): SessionUser {
    if (!this.setupRequired()) throw new AuthError('setup_complete');
    const legacy = this.#db
      .prepare("select id, email from users where role = 'operator' and password_hash is null")
      .all() as { id: string; email: string }[];

    if (legacy.length === 1) {
      const row = legacy[0] as { id: string; email: string };
      try {
        this.#db
          .prepare('update users set email = ?, name = ?, password_hash = ? where id = ?')
          .run(input.email, input.name, passwordHash, row.id);
        // Sessions that predate the password belong to whoever held the seed row.
        this.#db.prepare('delete from sessions where user_id = ?').run(row.id);
      } catch (error) {
        if (isEmailTaken(error)) throw new AuthError('email_taken');
        throw error;
      }
      return { id: row.id, email: input.email, name: input.name, role: 'operator', tenantId: null };
    }

    const user: SessionUser = {
      id: newId('usr'),
      email: input.email,
      name: input.name,
      role: 'operator',
      tenantId: null,
    };
    try {
      this.#db
        .prepare(
          'insert into users (id, email, name, role, tenant_id, password_hash, created_at) values (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          user.id,
          user.email,
          user.name,
          user.role,
          user.tenantId,
          passwordHash,
          this.#now().toISOString(),
        );
    } catch (error) {
      if (isEmailTaken(error)) throw new AuthError('email_taken');
      throw error;
    }
    return user;
  }

  /**
   * Verifies a password and opens a session. An unknown address and a wrong
   * password answer identically and take the same time: the check runs against
   * a dummy hash when there is no account.
   */
  async login(email: string, password: string, userAgent?: string): Promise<AuthResult> {
    const normalized = email.trim().toLowerCase();
    const row = this.#db
      .prepare('select id, email, name, role, tenant_id, password_hash from users where email = ?')
      .get(normalized) as UserWithPasswordRow | undefined;

    if (!row || row.password_hash === null) {
      await verifyAgainstDummy(password);
      throw new AuthError('invalid_credentials');
    }

    const matches = await verifyPassword(password, row.password_hash);
    if (!matches) throw new AuthError('invalid_credentials');

    const sessionToken = this.createSession(row.id, userAgent);
    this.#emit('auth.signed_in', { userId: row.id, role: row.role });
    return { user: toUser(row), sessionToken };
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
  }
}
