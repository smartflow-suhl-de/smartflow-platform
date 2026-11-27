import type { Role } from '../shared/contract.ts';
import type { PlatformEvents } from '../shared/events.ts';
import type { Config } from './config.ts';
import { hashToken } from './crypto.ts';
import type { Db } from './db.ts';
import { newId, token } from './ids.ts';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password.ts';

/** The auth service reports sign-ins, sign-outs and the first-run setup; the kernel owns the log. */
export type AuthEvents = <
  K extends 'auth.setup_completed' | 'auth.signed_in' | 'auth.signed_out' | 'auth.tenant_switched',
>(
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
  /** Fixed binding of the account; `null` for an operator. */
  tenantId: string | null;
  /**
   * The tenant this request may work in. `tenant_admin`/`employee`: always
   * `tenantId`. `operator`: the tenant chosen for this session, re-checked on
   * every request, else `null`. Tenant-bound code reads this, never `tenantId`.
   */
  activeTenantId: string | null;
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

function toUser(row: UserRow, activeTenantId: string | null = null): SessionUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    tenantId: row.tenant_id,
    activeTenantId: row.role === 'operator' ? activeTenantId : row.tenant_id,
  };
}

/** Upper bound for remembered operator contexts; the oldest entry goes first. */
const MAX_CONTEXTS = 10_000;

/** Answers whether a tenant exists and may be worked in right now. */
export type TenantGate = (tenantId: string) => boolean;

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
  /**
   * Operator context per session id, in memory on purpose: a restart keeps the
   * session but forgets the tenant, so nobody wakes up in the last tenant.
   * Map order is insertion order, which makes the oldest entry the first key.
   */
  readonly #context = new Map<string, string>();
  #tenantGate: TenantGate = () => false;

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

  /** Installed once the tenant plugin has registered; until then no tenant is usable. */
  useTenantGate(gate: TenantGate): void {
    this.#tenantGate = gate;
  }

  /**
   * Sets or clears the operator's active tenant for the session behind `plain`.
   * The caller has already checked the role and the tenant; nothing changes if
   * the session is unknown.
   */
  setActiveTenant(plain: string | undefined, tenantId: string | null): boolean {
    if (!plain) return false;
    const session = this.#db
      .prepare('select id from sessions where token_hash = ?')
      .get(hashToken(plain)) as { id: string } | undefined;
    if (!session) return false;
    if (tenantId === null) {
      this.#context.delete(session.id);
      return true;
    }
    this.#context.delete(session.id); // re-insert so this entry becomes the newest
    if (this.#context.size >= MAX_CONTEXTS) this.#makeRoom();
    this.#context.set(session.id, tenantId);
    return true;
  }

  /** Audit entry for a switch; IDs only. */
  recordTenantSwitch(change: {
    userId: string;
    fromTenantId: string | null;
    toTenantId: string | null;
  }): void {
    this.#emit('auth.tenant_switched', change);
  }

  /** Drops every context pointing at a tenant, e.g. after it was suspended. */
  clearTenantContext(tenantId: string): void {
    for (const [sessionId, chosen] of this.#context) {
      if (chosen === tenantId) this.#context.delete(sessionId);
    }
  }

  #makeRoom(): void {
    const alive = new Set(
      (this.#db.prepare('select id from sessions').all() as { id: string }[]).map((row) => row.id),
    );
    for (const sessionId of this.#context.keys()) {
      if (!alive.has(sessionId)) this.#context.delete(sessionId);
    }
    while (this.#context.size >= MAX_CONTEXTS) {
      const oldest = this.#context.keys().next().value;
      if (oldest === undefined) break;
      this.#context.delete(oldest);
    }
  }

  /** Test and diagnostics only: how many contexts are held. */
  contextCount(): number {
    return this.#context.size;
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
      return {
        id: row.id,
        email: input.email,
        name: input.name,
        role: 'operator',
        tenantId: null,
        activeTenantId: null,
      };
    }

    const user: SessionUser = {
      id: newId('usr'),
      email: input.email,
      name: input.name,
      role: 'operator',
      tenantId: null,
      activeTenantId: null,
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
      this.#context.delete(session.id);
      return null;
    }
    const user = this.#db
      .prepare('select id, email, name, role, tenant_id from users where id = ?')
      .get(session.user_id) as UserRow | undefined;
    if (!user) return null;
    this.#db
      .prepare('update sessions set last_seen_at = ? where id = ?')
      .run(this.#now().toISOString(), session.id);
    // Fresh check on every request: a tenant that was suspended or removed
    // since the choice drops out here instead of living on in the cache.
    let active: string | null = null;
    if (user.role === 'operator') {
      const chosen = this.#context.get(session.id) ?? null;
      if (chosen !== null && this.#tenantGate(chosen)) active = chosen;
      else if (chosen !== null) this.#context.delete(session.id);
    }
    return toUser(user, active);
  }

  destroySession(plain: string | undefined): void {
    if (!plain) return;
    const hash = hashToken(plain);
    const session = this.#db
      .prepare('select id, user_id from sessions where token_hash = ?')
      .get(hash) as { id: string; user_id: string } | undefined;
    if (!session) return;
    this.#db.prepare('delete from sessions where token_hash = ?').run(hash);
    this.#context.delete(session.id);
    this.#emit('auth.signed_out', { userId: session.user_id });
  }

  pruneSessions(): void {
    this.#db.prepare('delete from sessions where expires_at <= ?').run(this.#now().toISOString());
    const alive = new Set(
      (this.#db.prepare('select id from sessions').all() as { id: string }[]).map((row) => row.id),
    );
    for (const sessionId of this.#context.keys()) {
      if (!alive.has(sessionId)) this.#context.delete(sessionId);
    }
  }
}
