import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../kernel/db.ts';
import type { PluginContext } from '../../kernel/context.ts';
import { AppError } from '../../kernel/errors.ts';
import { newId } from '../../kernel/ids.ts';
import { openSecretBox, type SecretBox } from '../../kernel/secrets.ts';
import {
  parseAllowedPlugins,
  toProvider,
  type ModelRow,
  type ProviderRow,
  type PurposeRow,
  type UsageRow,
} from './store.ts';
import type { ProviderDto } from './protocol.ts';

export interface UsageInput {
  providerId: string | null;
  modelId: string | null;
  purpose: string;
  caller: string;
  tenantId: string | null;
  status: 'ok' | 'error';
  errorCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicros: number;
  latencyMs: number | null;
  requestId: string | null;
}

/**
 * Process-local state and the small database helpers both route groups share.
 * Every method is synchronous: SQLite is in-process and the upstream call is
 * the only thing that waits.
 */
export class LlmRuntime {
  readonly db: Db;
  readonly log: FastifyBaseLogger;
  readonly now: () => Date;
  readonly maxTimeoutMs: number;
  readonly allowHttp: boolean;
  readonly #box: SecretBox;

  constructor(ctx: PluginContext) {
    this.db = ctx.db;
    this.log = ctx.log;
    this.now = ctx.now;
    this.maxTimeoutMs = readInt(process.env.SF_LLM_MAX_TIMEOUT_MS, 60_000, 1_000, 60_000);
    this.allowHttp = process.env.SF_LLM_ALLOW_HTTP === '1';
    this.#box = openSecretBox(ctx.config.dataDir);
  }

  provider(id: string): ProviderRow | undefined {
    return this.db.prepare('select * from llm_provider where id = ?').get(id) as
      ProviderRow | undefined;
  }

  model(id: string): ModelRow | undefined {
    return this.db.prepare('select * from llm_model where id = ?').get(id) as ModelRow | undefined;
  }

  purpose(name: string): PurposeRow | undefined {
    return this.db.prepare('select * from llm_purpose where purpose = ?').get(name) as
      PurposeRow | undefined;
  }

  modelCount(providerId: string): number {
    const row = this.db
      .prepare('select count(*) as count from llm_model where provider_id = ?')
      .get(providerId) as { count: number };
    return row.count;
  }

  toProvider(row: ProviderRow, modelCount = this.modelCount(row.id)): ProviderDto {
    return toProvider(row, modelCount);
  }

  /** Seals a key; the caller never sees this string outside the database. */
  sealKey(value: string): string {
    return this.#box.seal(value);
  }

  /** A key that cannot be opened is a fact about the data directory, not a guess. */
  openKey(provider: ProviderRow): string | null {
    if (!provider.api_key_sealed) return null;
    try {
      return this.#box.open(provider.api_key_sealed);
    } catch {
      throw new AppError(
        'llm_secret_unreadable',
        'The stored API key can no longer be opened.',
        409,
        { reason: 'secret_unreadable' },
      );
    }
  }

  sealHeaders(headers: Record<string, string>): string {
    return this.#box.seal(JSON.stringify(headers));
  }

  openHeaders(provider: ProviderRow): Record<string, string> {
    if (!provider.extra_headers_sealed) return {};
    try {
      const value = JSON.parse(this.#box.open(provider.extra_headers_sealed)) as unknown;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
      const headers: Record<string, string> = {};
      for (const [name, item] of Object.entries(value)) {
        if (typeof item === 'string') headers[name] = item;
      }
      return headers;
    } catch {
      throw new AppError(
        'llm_secret_unreadable',
        'The stored extra headers can no longer be opened.',
        409,
        { reason: 'secret_unreadable' },
      );
    }
  }

  isAllowedFor(provider: ProviderRow, caller: string): boolean {
    const allowed = parseAllowedPlugins(provider.allowed_plugins);
    return allowed === null || allowed.includes(caller);
  }

  recordUsage(input: UsageInput): string {
    const id = newId('llm_u');
    this.db
      .prepare(
        `insert into llm_usage
         (id, provider_id, model_id, purpose, caller, tenant_id, status, error_code,
          input_tokens, output_tokens, cost_micros, latency_ms, request_id, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.providerId,
        input.modelId,
        input.purpose,
        input.caller,
        input.tenantId,
        input.status,
        input.errorCode,
        input.inputTokens,
        input.outputTokens,
        input.costMicros,
        input.latencyMs,
        input.requestId,
        this.now().toISOString(),
      );
    return id;
  }

  recordTest(providerId: string, status: string, ms: number): void {
    const at = this.now().toISOString();
    this.db
      .prepare(
        'update llm_provider set last_test_at = ?, last_test_status = ?, last_test_ms = ? where id = ?',
      )
      .run(at, status, ms, providerId);
  }

  /**
   * Daily token and monthly budget caps, counted from the usage table.
   *
   * The check runs before the upstream call while usage is written after it,
   * so concurrent requests can overshoot the cap by at most one in-flight call
   * per provider. That window is accepted; a hard reservation would need a
   * shared counter in the kernel.
   */
  budgetExceeded(provider: ProviderRow): 'daily' | 'monthly' | null {
    if (provider.daily_token_limit > 0) {
      const since = new Date(this.now());
      since.setUTCHours(0, 0, 0, 0);
      const row = this.db
        .prepare(
          `select coalesce(sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)), 0) as tokens
           from llm_usage where provider_id = ? and created_at >= ?`,
        )
        .get(provider.id, since.toISOString()) as { tokens: number };
      if (row.tokens >= provider.daily_token_limit) return 'daily';
    }
    if (provider.monthly_budget_micros > 0) {
      const since = new Date(this.now());
      since.setUTCDate(1);
      since.setUTCHours(0, 0, 0, 0);
      const row = this.db
        .prepare(
          `select coalesce(sum(cost_micros), 0) as cost
           from llm_usage where provider_id = ? and created_at >= ?`,
        )
        .get(provider.id, since.toISOString()) as { cost: number };
      if (row.cost >= provider.monthly_budget_micros) return 'monthly';
    }
    return null;
  }

  /** Per provider retention; rows without a provider use the default 90 days. */
  purgeUsage(defaultDays = 90): void {
    const providers = this.db
      .prepare('select id, retention_days from llm_provider')
      .all() as Array<{ id: string; retention_days: number }>;
    for (const provider of providers) {
      const cutoff = new Date(this.now().getTime() - provider.retention_days * 86_400_000);
      this.db
        .prepare('delete from llm_usage where provider_id = ? and created_at < ?')
        .run(provider.id, cutoff.toISOString());
    }
    const cutoff = new Date(this.now().getTime() - defaultDays * 86_400_000);
    this.db
      .prepare('delete from llm_usage where provider_id is null and created_at < ?')
      .run(cutoff.toISOString());
  }
}

export function readInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = raw === undefined || raw === '' ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export type { UsageRow };
