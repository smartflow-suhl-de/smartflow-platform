import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type {
  AgentDataSource,
  AgentSourceView,
  PluginManifest,
  TenantStatus,
} from '../shared/contract.ts';
import type { EventName, PlatformEvents } from '../shared/events.ts';
import type { Config } from './config.ts';
import type { Db, Migration } from './db.ts';

/** What the kernel needs to know about a tenant to open its database. */
export interface TenantRef {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
}

/**
 * Provided by the tenant-owning plugin; the kernel only asks, never writes.
 * `list` exists so a plugin that has to count across tenants (the overview)
 * does not read the tenant table directly — that table belongs to another
 * plugin.
 */
export interface TenantDirectory {
  resolve(tenantId: string): TenantRef | null;
  list(): TenantRef[];
}

/**
 * Everything a plugin may use. The plugin gets its own encapsulated Fastify
 * scope (`app`), already mounted under `/api/v1`, and never touches another
 * plugin's tables.
 */
export interface PluginContext {
  manifest: PluginManifest;
  app: FastifyInstance;
  config: Config;
  /** Platform database. Kernel tables plus this plugin's own tables. */
  db: Db;
  log: FastifyBaseLogger;
  /** Verified tenant database; throws `tenant_not_found` for unknown tenants. */
  tenantDb(tenantId: string): Db;
  /**
   * Every tenant, from the plugin that owns them. A plugin that counts across
   * tenants (the overview) asks here instead of reading the tenant table.
   */
  tenants(): TenantRef[];
  provideTenantDirectory(directory: TenantDirectory): void;
  /**
   * Registers a read-only question the agent may ask this plugin. The agent
   * never reads another plugin's tables; it calls `run` in this process.
   * Registration fails on a duplicate id, so two plugins cannot shadow one
   * source. The list is read at request time, not when the agent registers.
   */
  provideAgentSource(source: AgentDataSource): void;
  /**
   * Every registered source as an info view, in registration order. It has no
   * `run`: a plugin cannot call another plugin's source around the checks.
   */
  agentSources(): AgentSourceView[];
  /**
   * Runs one source. The kernel validates `rawArgs` against the source's
   * schema first and throws `ArgumentError` on a mismatch; an unknown id
   * throws `Error`.
   */
  runAgentSource(sourceId: string, rawArgs: unknown): Promise<unknown>;
  /** Plugin-scoped migrations against the platform database. */
  migrate(migrations: Migration[]): void;
  /** Plugin-scoped migrations applied to every tenant database when it opens. */
  migrateTenant(migrations: Migration[]): void;
  emit<K extends EventName>(name: K, payload: PlatformEvents[K]): void;
  on<K extends EventName>(
    name: K,
    handler: (payload: PlatformEvents[K]) => void | Promise<void>,
  ): void;
  now(): Date;
  /**
   * Proof that a call comes from this process, not from a browser.
   *
   * A plugin sometimes has to call another plugin's route on behalf of code
   * that has no session — an interview answered over a public link, for
   * example. Sending the operator's cookie would be a forged identity; this
   * token is a separate one, generated at startup, never sent to a client, and
   * only accepted by routes that ask for it explicitly.
   */
  internalToken: string;
  /**
   * Calls another plugin's route as this process, without a session. Returns
   * the raw status and body: the caller decides what a failure means, because
   * the kernel does not know the route's semantics.
   */
  callInternal(caller: string, request: InternalRequest): Promise<InternalResponse>;
}

/** A route call made by a plugin for its own account, without a session. */
export interface InternalRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  payload?: unknown;
}

export interface InternalResponse {
  status: number;
  body: string;
}

export type PluginRegister = (ctx: PluginContext) => void | Promise<void>;

export interface PluginModule {
  manifest: PluginManifest;
  register: PluginRegister;
}
