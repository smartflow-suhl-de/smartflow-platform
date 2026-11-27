import { FieldError } from '../../shared/contract.ts';
import type { PluginContext } from '../../kernel/context.ts';
import { decodeCursor, encodeCursor } from '../../kernel/cursor.ts';
import { AppError } from '../../kernel/errors.ts';
import { newId } from '../../kernel/ids.ts';
import { generatedPlugins } from '../../kernel/plugin-registry.generated.ts';
import { registerInternalRoutes } from './internal.ts';
import { manifest } from './manifest.ts';
import {
  isValidChatPath,
  isBlockedExtraHeader,
  loopbackAllowed,
  validateBaseUrl as validateTargetUrl,
} from './ssrf.ts';
import type { AuthStyle, Capabilities, ProviderStatus, ProviderTestResult } from './protocol.ts';
import { LlmRuntime, readInt } from './runtime.ts';
import {
  toModel,
  toPurpose,
  toPurposeModelRef,
  toUsage,
  type ModelRow,
  type ProviderRow,
  type PurposeRow,
  type UsageRow,
} from './store.ts';
import { UpstreamError, listModels } from './upstream.ts';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;
const TEST_INTERVAL_MS = 10_000;

const errorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: true,
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        fields: { type: 'object', additionalProperties: { type: 'string' } },
      },
    },
  },
} as const;

/** Response schemas stay open: the DTO is defined in protocol.ts. */
const objectSchema = { type: 'object', additionalProperties: true } as const;

const providerBody = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'baseUrl'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 },
    preset: { type: 'string', maxLength: 40 },
    baseUrl: { type: 'string', minLength: 1, maxLength: 500 },
    chatPath: { type: 'string', maxLength: 200 },
    apiVersion: { type: ['string', 'null'], maxLength: 50 },
    authStyle: { type: 'string', enum: ['bearer', 'header', 'none'] },
    authHeader: { type: ['string', 'null'], maxLength: 100 },
    apiKey: { type: 'string', maxLength: 4000 },
    extraHeaders: { type: 'object', additionalProperties: { type: 'string' } },
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 60000 },
    maxRetries: { type: 'integer', minimum: 0, maximum: 3 },
    rateLimitPerMinute: { type: 'integer', minimum: 1, maximum: 600 },
    dailyTokenLimit: { type: 'integer', minimum: 0 },
    monthlyBudgetMicros: { type: 'integer', minimum: 0 },
    retentionDays: { type: 'integer', minimum: 1, maximum: 365 },
    allowedPlugins: { type: ['array', 'null'], items: { type: 'string' } },
    status: { type: 'string', enum: ['active', 'disabled'] },
    isDefault: { type: 'boolean' },
  },
} as const;

const providerPatchBody = {
  ...providerBody,
  required: [],
} as const;

const modelBody = {
  type: 'object',
  additionalProperties: false,
  required: ['modelKey'],
  properties: {
    modelKey: { type: 'string', minLength: 1, maxLength: 200 },
    label: { type: 'string', maxLength: 120 },
    contextWindow: { type: ['integer', 'null'], minimum: 1 },
    maxOutputTokens: { type: ['integer', 'null'], minimum: 1 },
    capabilities: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tools: { type: 'boolean' },
        json: { type: 'boolean' },
        vision: { type: 'boolean' },
        embeddings: { type: 'boolean' },
      },
    },
    inputCostMicrosPerMtok: { type: 'integer', minimum: 0 },
    outputCostMicrosPerMtok: { type: 'integer', minimum: 0 },
    isDefault: { type: 'boolean' },
    source: { type: 'string', enum: ['manual', 'discovered'] },
    status: { type: 'string', enum: ['active', 'disabled'] },
  },
} as const;

const modelPatchBody = { ...modelBody, required: [] } as const;

const purposeBody = {
  type: 'object',
  additionalProperties: false,
  required: ['purpose'],
  properties: {
    purpose: { type: 'string', minLength: 3, maxLength: 80 },
    modelId: { type: ['string', 'null'] },
    fallbackModelId: { type: ['string', 'null'] },
    description: { type: ['string', 'null'], maxLength: 500 },
  },
} as const;

const purposePatchBody = { ...purposeBody, required: [] } as const;

interface ProviderBody {
  name?: string;
  preset?: string;
  baseUrl?: string;
  chatPath?: string;
  apiVersion?: string | null;
  authStyle?: AuthStyle;
  authHeader?: string | null;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  rateLimitPerMinute?: number;
  dailyTokenLimit?: number;
  monthlyBudgetMicros?: number;
  retentionDays?: number;
  allowedPlugins?: string[] | null;
  status?: ProviderStatus;
  isDefault?: boolean;
}

interface ProviderDraft {
  name: string;
  preset: string;
  baseUrl: string;
  chatPath: string;
  apiVersion: string | null;
  authStyle: AuthStyle;
  authHeader: string | null;
  apiKey: string | null;
  extraHeaders: Record<string, string> | null;
  timeoutMs: number;
  maxRetries: number;
  rateLimitPerMinute: number;
  dailyTokenLimit: number;
  monthlyBudgetMicros: number;
  retentionDays: number;
  allowedPlugins: string[] | null;
  status: ProviderStatus;
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const PLUGIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PURPOSE_NAME = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*$/;

function originOf(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return raw;
  }
}

function parseLimit(raw: string | undefined): number {
  const value = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, value));
}

function validateBaseUrl(raw: string, allowHttp: boolean): string {
  try {
    return validateTargetUrl(raw, { allowHttp, allowLoopback: loopbackAllowed() });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'scheme') {
      throw new FieldError({
        baseUrl:
          'Use https. Plain http is only allowed for internal gateways with SF_LLM_ALLOW_HTTP=1.',
      });
    }
    if (code === 'credentials') {
      throw new FieldError({ baseUrl: 'Do not put credentials in the URL.' });
    }
    if (code === 'query') {
      throw new FieldError({ baseUrl: 'The base URL must not contain a query or fragment.' });
    }
    if (code === 'loopback') {
      throw new FieldError({
        baseUrl:
          'A loopback address needs SF_LLM_ALLOW_LOOPBACK=1 on the server, for a local gateway.',
      });
    }
    if (code === 'host' || code === 'address') {
      throw new FieldError({ baseUrl: 'This address is not allowed.' });
    }
    throw new FieldError({ baseUrl: 'Please enter a valid URL.' });
  }
}

function validateChatPath(raw: string): string {
  const value = raw.trim();
  if (!isValidChatPath(value)) {
    throw new FieldError({
      chatPath: 'Use a relative path without "..", query, fragment or double slash.',
    });
  }
  return value;
}

function validateExtraHeaders(raw: Record<string, string>): { sealed: string; names: string[] } {
  const entries = Object.entries(raw);
  if (entries.length > 20) {
    throw new FieldError({ extraHeaders: 'Use at most 20 extra headers.' });
  }
  const names: string[] = [];
  for (const [name, value] of entries) {
    if (!HEADER_NAME.test(name)) {
      throw new FieldError({ extraHeaders: `Invalid header name: ${name}` });
    }
    if (isBlockedExtraHeader(name)) {
      throw new FieldError({
        extraHeaders: `Header ${name} is managed by the platform or carries credentials.`,
      });
    }
    if (value.length > 2000) {
      throw new FieldError({ extraHeaders: `Header ${name} is too long.` });
    }
    names.push(name);
  }
  return { sealed: JSON.stringify(raw), names };
}

function validateAllowedPlugins(raw: string[] | null | undefined): string[] | null {
  if (raw === null || raw === undefined) return null;
  const unique = [...new Set(raw.map((item) => item.trim()).filter(Boolean))];
  const invalid = unique.find((item) => !PLUGIN_ID.test(item));
  if (invalid) {
    throw new FieldError({ allowedPlugins: `Invalid plugin id: ${invalid}` });
  }
  return unique.length === 0 ? null : unique;
}

function validateDraft(
  draft: ProviderDraft,
  hasStoredKey: boolean,
  allowHttp: boolean,
): ProviderDraft {
  const fields: Record<string, string> = {};

  const name = draft.name.trim();
  if (name.length < 1 || name.length > 80)
    fields.name = 'Please enter a name of 1 to 80 characters.';

  const preset = draft.preset.trim();
  if (preset.length < 1 || preset.length > 40) fields.preset = 'Please enter a preset.';

  let baseUrl = draft.baseUrl;
  try {
    baseUrl = validateBaseUrl(draft.baseUrl, allowHttp);
  } catch (error) {
    if (error instanceof FieldError) Object.assign(fields, error.fields);
    else throw error;
  }

  let chatPath = draft.chatPath;
  try {
    chatPath = validateChatPath(draft.chatPath);
  } catch (error) {
    if (error instanceof FieldError) Object.assign(fields, error.fields);
    else throw error;
  }

  const apiVersion = draft.apiVersion?.trim() || null;
  if (apiVersion && apiVersion.length > 50) fields.apiVersion = 'The API version is too long.';

  let authHeader = draft.authHeader?.trim() || null;
  if (draft.authStyle === 'header' && !authHeader) {
    fields.authHeader = 'A custom auth style needs a header name.';
  }
  if (authHeader && !HEADER_NAME.test(authHeader)) {
    fields.authHeader = 'Invalid header name.';
  }
  if (draft.authStyle === 'bearer' && !authHeader) authHeader = 'Authorization';
  if (draft.authStyle === 'none') authHeader = null;

  if (draft.authStyle !== 'none' && !draft.apiKey && !hasStoredKey) {
    fields.apiKey = 'A credential is required for this auth style.';
  }

  const extraHeaders = draft.extraHeaders;
  if (extraHeaders) {
    try {
      validateExtraHeaders(extraHeaders);
    } catch (error) {
      if (error instanceof FieldError) Object.assign(fields, error.fields);
      else throw error;
    }
  }

  if (draft.timeoutMs < 1000 || draft.timeoutMs > 120_000) {
    fields.timeoutMs = 'Use a timeout between 1 and 120 seconds.';
  }
  if (draft.maxRetries < 0 || draft.maxRetries > 5) {
    fields.maxRetries = 'Use 0 to 5 retries.';
  }
  if (draft.rateLimitPerMinute < 1 || draft.rateLimitPerMinute > 600) {
    fields.rateLimitPerMinute = 'Use 1 to 600 calls per minute.';
  }
  if (draft.dailyTokenLimit < 0) fields.dailyTokenLimit = 'The limit must not be negative.';
  if (draft.monthlyBudgetMicros < 0) {
    fields.monthlyBudgetMicros = 'The budget must not be negative.';
  }
  if (draft.retentionDays < 1 || draft.retentionDays > 365) {
    fields.retentionDays = 'Use 1 to 365 days.';
  }

  if (Object.keys(fields).length > 0) throw new FieldError(fields);

  return {
    name,
    preset,
    baseUrl,
    chatPath,
    apiVersion,
    authStyle: draft.authStyle,
    authHeader,
    apiKey: draft.apiKey ?? null,
    extraHeaders: extraHeaders ?? null,
    timeoutMs: draft.timeoutMs,
    maxRetries: draft.maxRetries,
    rateLimitPerMinute: draft.rateLimitPerMinute,
    dailyTokenLimit: draft.dailyTokenLimit,
    monthlyBudgetMicros: draft.monthlyBudgetMicros,
    retentionDays: draft.retentionDays,
    allowedPlugins: validateAllowedPlugins(draft.allowedPlugins),
    status: draft.status,
  };
}

function validatePurposeName(raw: string): string {
  const value = raw.trim();
  if (!PURPOSE_NAME.test(value) || value.length > 80) {
    throw new FieldError({
      purpose: 'Use lowercase letters, digits, hyphens and optional dots (e.g. chat.default).',
    });
  }
  return value;
}

function isUniqueError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code ?? '';
  return code.startsWith('SQLITE_CONSTRAINT');
}

export function register(ctx: PluginContext): void {
  const { app, db } = ctx;
  const runtime = new LlmRuntime(ctx);

  ctx.migrate([
    {
      version: 1,
      up(database) {
        database.exec(`
          create table llm_provider (
            id text primary key,
            name text not null,
            preset text not null default 'custom',
            base_url text not null,
            chat_path text not null default '/chat/completions',
            api_version text,
            auth_style text not null check (auth_style in ('bearer', 'header', 'none')),
            auth_header text,
            api_key_sealed text,
            api_key_updated_at text,
            extra_headers_sealed text,
            extra_header_names text not null default '[]',
            timeout_ms integer not null default 30000,
            max_retries integer not null default 1,
            rate_limit_per_minute integer not null default 60,
            daily_token_limit integer not null default 0,
            monthly_budget_micros integer not null default 0,
            retention_days integer not null default 90,
            allowed_plugins text,
            status text not null default 'active' check (status in ('active', 'disabled')),
            last_test_at text,
            last_test_status text,
            last_test_ms integer,
            created_at text not null,
            updated_at text not null,
            created_by text not null
          );
          create index llm_provider_created on llm_provider(created_at, id);
          create index llm_provider_status on llm_provider(status);

          create table llm_model (
            id text primary key,
            provider_id text not null references llm_provider(id) on delete restrict,
            model_key text not null,
            label text not null,
            context_window integer,
            max_output_tokens integer,
            capabilities text not null default '{}',
            input_cost_micros_per_mtok integer not null default 0,
            output_cost_micros_per_mtok integer not null default 0,
            is_default integer not null default 0,
            source text not null default 'manual' check (source in ('manual', 'discovered')),
            status text not null default 'active' check (status in ('active', 'disabled')),
            created_at text not null,
            unique (provider_id, model_key)
          );
          create index llm_model_provider on llm_model(provider_id);

          create table llm_purpose (
            purpose text primary key,
            model_id text references llm_model(id) on delete restrict,
            fallback_model_id text references llm_model(id) on delete restrict,
            description text,
            updated_at text not null,
            updated_by text not null
          );

          create table llm_usage (
            id text primary key,
            provider_id text references llm_provider(id) on delete set null,
            model_id text references llm_model(id) on delete set null,
            purpose text not null,
            caller text not null,
            tenant_id text,
            status text not null check (status in ('ok', 'error')),
            error_code text,
            input_tokens integer,
            output_tokens integer,
            cost_micros integer not null default 0,
            latency_ms integer,
            request_id text,
            created_at text not null
          );
          create index llm_usage_created on llm_usage(created_at, id);
          create index llm_usage_caller on llm_usage(caller, created_at);
          create index llm_usage_purpose on llm_usage(purpose, created_at);
          create index llm_usage_provider on llm_usage(provider_id, created_at);
        `);
      },
    },
    {
      version: 2,
      up(database) {
        database.exec(`
          create table llm_log (
            id text primary key,
            level text not null check (level in ('info', 'warn', 'error')),
            action text not null,
            provider_id text,
            provider_name text,
            message text not null,
            created_at text not null
          );
          create index llm_log_created on llm_log(created_at, id);
          create index llm_log_level on llm_log(level, created_at);
        `);
      },
    },
    {
      version: 3,
      up(database) {
        database.exec(`
          alter table llm_provider add column is_default integer not null default 0;
          update llm_provider set is_default = 1
           where id = (
             select id from llm_provider
              order by case when status = 'active' then 0 else 1 end, created_at asc, id asc
              limit 1
           );
        `);
      },
    },
  ]);

  function recordLog(
    level: 'info' | 'warn' | 'error',
    action: string,
    message: string,
    provider?: { id?: string | null; name?: string | null },
  ): void {
    try {
      db.prepare(
        `insert into llm_log (id, level, action, provider_id, provider_name, message, created_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newId('llm_l'),
        level,
        action,
        provider?.id ?? null,
        provider?.name ?? null,
        message,
        ctx.now().toISOString(),
      );
    } catch (error) {
      ctx.log.warn({ err: error, action }, 'llm plugin log insert failed');
    }
  }

  // Old rows disappear at start and once a day; the timer never keeps a test
  // process alive because it is unref'd.
  try {
    runtime.purgeUsage(readInt(process.env.SF_LLM_RETENTION_DAYS, 90, 1, 365));
  } catch (error) {
    ctx.log.warn({ err: error }, 'llm usage retention failed');
  }
  const purgeTimer = setInterval(
    () => {
      try {
        runtime.purgeUsage(readInt(process.env.SF_LLM_RETENTION_DAYS, 90, 1, 365));
      } catch (error) {
        ctx.log.warn({ err: error }, 'llm usage retention failed');
      }
    },
    24 * 60 * 60 * 1000,
  );
  purgeTimer.unref();

  const operator = app.requireRole('operator');

  app.get(
    '/llm/plugins',
    {
      preHandler: operator,
      schema: {
        summary: 'List installed plugins and whether they declare LLM usage',
        tags: ['llm-providers'],
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'label', 'description', 'needsLlm'],
                  properties: {
                    id: { type: 'string' },
                    label: { type: 'string' },
                    description: { type: 'string' },
                    needsLlm: { type: 'boolean' },
                  },
                },
              },
            },
          },
          401: errorSchema,
          403: errorSchema,
        },
      },
    },
    async (_request, reply) => {
      const items = generatedPlugins
        .filter((entry) => entry.manifest.id !== manifest.id)
        .map((entry) => ({
          id: entry.manifest.id,
          label: entry.manifest.label,
          description: entry.manifest.description,
          needsLlm: Boolean(entry.manifest.dependsOn?.includes('llm-providers')),
        }));
      reply.type('application/json');
      return { items };
    },
  );

  app.get<{
    Querystring: { level?: 'info' | 'warn' | 'error'; limit?: string; cursor?: string };
  }>(
    '/llm/logs',
    {
      preHandler: operator,
      schema: {
        summary: 'List operational logs of the LLM provider plugin',
        tags: ['llm-providers'],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            level: { type: 'string', enum: ['info', 'warn', 'error'] },
            limit: { type: 'string' },
            cursor: { type: 'string' },
          },
        },
        response: {
          200: objectSchema,
          400: errorSchema,
          401: errorSchema,
          403: errorSchema,
        },
      },
    },
    async (request) => {
      const limit = parseLimit(request.query.limit);
      const where: string[] = [];
      const params: unknown[] = [];
      if (request.query.level) {
        where.push('level = ?');
        params.push(request.query.level);
      }
      const whereSql = where.length > 0 ? `where ${where.join(' and ')}` : '';
      const total = (
        db.prepare(`select count(*) as n from llm_log ${whereSql}`).get(...params) as { n: number }
      ).n;

      const pageWhere = [...where];
      const pageParams = [...params];
      if (request.query.cursor) {
        const cursor = decodeCursor(request.query.cursor);
        if (!cursor) {
          throw new AppError('invalid_cursor', 'The pagination cursor is invalid.', 400);
        }
        pageWhere.push('(created_at < ? or (created_at = ? and id < ?))');
        pageParams.push(cursor.created_at, cursor.created_at, cursor.id);
      }
      const pageWhereSql = pageWhere.length > 0 ? `where ${pageWhere.join(' and ')}` : '';
      const rows = db
        .prepare(
          `select id, level, action, provider_id, provider_name, message, created_at
           from llm_log ${pageWhereSql}
           order by created_at desc, id desc
           limit ?`,
        )
        .all(...pageParams, limit + 1) as Array<{
        id: string;
        level: 'info' | 'warn' | 'error';
        action: string;
        provider_id: string | null;
        provider_name: string | null;
        message: string;
        created_at: string;
      }>;
      const hasMore = rows.length > limit;
      const slice = hasMore ? rows.slice(0, limit) : rows;
      const last = slice.at(-1);
      return {
        items: slice.map((row) => ({
          id: row.id,
          level: row.level,
          action: row.action,
          providerId: row.provider_id,
          providerName: row.provider_name,
          message: row.message,
          createdAt: row.created_at,
        })),
        total,
        nextCursor: hasMore && last ? encodeCursor({ created_at: last.created_at, id: last.id }) : null,
      };
    },
  );

  app.get<{
    Querystring: { status?: ProviderStatus; q?: string; limit?: string; cursor?: string };
  }>(
    '/llm/providers',
    {
      preHandler: operator,
      schema: {
        summary: 'List LLM providers',
        tags: ['llm-providers'],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['active', 'disabled'] },
            q: { type: 'string', maxLength: 80 },
            limit: { type: 'string' },
            cursor: { type: 'string' },
          },
        },
        response: { 200: objectSchema, 401: errorSchema, 403: errorSchema },
      },
    },
    async (request) => {
      const limit = parseLimit(request.query.limit);
      const where: string[] = [];
      const params: unknown[] = [];
      if (request.query.status) {
        where.push('p.status = ?');
        params.push(request.query.status);
      }
      if (request.query.q) {
        where.push('(lower(p.name) like ? or lower(p.base_url) like ?)');
        const needle = `%${request.query.q.toLowerCase()}%`;
        params.push(needle, needle);
      }
      const filter = where.length > 0 ? `where ${where.join(' and ')}` : '';
      const total = (
        db.prepare(`select count(*) as count from llm_provider p ${filter}`).get(...params) as {
          count: number;
        }
      ).count;

      let cursor = null;
      if (request.query.cursor) {
        cursor = decodeCursor(request.query.cursor);
        if (!cursor) throw new AppError('invalid_cursor', 'The cursor is invalid.', 400);
      }
      const pageWhere = [...where];
      const pageParams = [...params];
      if (cursor) {
        pageWhere.push('(p.created_at < ? or (p.created_at = ? and p.id < ?))');
        pageParams.push(cursor.created_at, cursor.created_at, cursor.id);
      }
      const pageFilter = pageWhere.length > 0 ? `where ${pageWhere.join(' and ')}` : '';
      const rows = db
        .prepare(
          `select p.*, (select count(*) from llm_model m where m.provider_id = p.id) as model_count
           from llm_provider p ${pageFilter}
           order by p.created_at desc, p.id desc limit ?`,
        )
        .all(...pageParams, limit + 1) as Array<ProviderRow & { model_count: number }>;
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);
      return {
        items: page.map((row) => runtime.toProvider(row, row.model_count)),
        total,
        nextCursor:
          hasMore && last ? encodeCursor({ created_at: last.created_at, id: last.id }) : null,
      };
    },
  );

  app.post<{ Body: ProviderBody }>(
    '/llm/providers',
    {
      preHandler: operator,
      schema: {
        summary: 'Create a custom LLM provider',
        tags: ['llm-providers'],
        body: providerBody,
        response: {
          201: objectSchema,
          401: errorSchema,
          403: errorSchema,
          422: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const draft = validateDraft(
        {
          name: body.name ?? '',
          preset: body.preset ?? 'custom',
          baseUrl: body.baseUrl ?? '',
          chatPath: body.chatPath ?? '/chat/completions',
          apiVersion: body.apiVersion ?? null,
          authStyle: body.authStyle ?? 'bearer',
          authHeader: body.authHeader ?? null,
          apiKey: body.apiKey ?? null,
          extraHeaders: body.extraHeaders ?? null,
          timeoutMs: body.timeoutMs ?? 30_000,
          maxRetries: body.maxRetries ?? 1,
          rateLimitPerMinute: body.rateLimitPerMinute ?? 60,
          dailyTokenLimit: body.dailyTokenLimit ?? 0,
          monthlyBudgetMicros: body.monthlyBudgetMicros ?? 0,
          retentionDays: body.retentionDays ?? 90,
          allowedPlugins: body.allowedPlugins ?? null,
          status: body.status ?? 'active',
        },
        false,
        runtime.allowHttp,
      );

      const now = ctx.now().toISOString();
      const id = newId('llm_p');
      const existingCount = (
        db.prepare('select count(*) as count from llm_provider').get() as { count: number }
      ).count;
      const isDefault = body.isDefault === true || existingCount === 0;
      if (isDefault) {
        db.prepare('update llm_provider set is_default = 0').run();
      }
      const extra =
        draft.extraHeaders && Object.keys(draft.extraHeaders).length > 0
          ? validateExtraHeaders(draft.extraHeaders)
          : null;
      db.prepare(
        `insert into llm_provider
         (id, name, preset, base_url, chat_path, api_version, auth_style, auth_header,
          api_key_sealed, api_key_updated_at, extra_headers_sealed, extra_header_names,
          timeout_ms, max_retries, rate_limit_per_minute, daily_token_limit,
          monthly_budget_micros, retention_days, allowed_plugins, status, is_default,
          created_at, updated_at, created_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        draft.name,
        draft.preset,
        draft.baseUrl,
        draft.chatPath,
        draft.apiVersion,
        draft.authStyle,
        draft.authHeader,
        draft.apiKey ? runtime.sealKey(draft.apiKey) : null,
        draft.apiKey ? now : null,
        extra ? runtime.sealHeaders(draft.extraHeaders as Record<string, string>) : null,
        JSON.stringify(extra?.names ?? []),
        draft.timeoutMs,
        draft.maxRetries,
        draft.rateLimitPerMinute,
        draft.dailyTokenLimit,
        draft.monthlyBudgetMicros,
        draft.retentionDays,
        draft.allowedPlugins ? JSON.stringify(draft.allowedPlugins) : null,
        draft.status,
        isDefault ? 1 : 0,
        now,
        now,
        request.user?.id ?? 'unknown',
      );
      reply.code(201);
      recordLog('info', 'provider.created', `Provider "${draft.name}" angelegt (${draft.baseUrl}).`, {
        id,
        name: draft.name,
      });
      return runtime.toProvider(runtime.provider(id) as ProviderRow);
    },
  );

  const MARTLLM_API_BASE = 'https://api.martllm.com';
  const MARTLLM_TRUSTED_HOSTS = new Set(['api.martllm.com', 'api.uberllm.dev']);

  interface MartLlmCatalogEntry {
    id: string;
    label: string;
    contextWindow: number | null;
    maxOutputTokens: number | null;
    capabilities: Capabilities;
    inputCostMicrosPerMtok: number;
    outputCostMicrosPerMtok: number;
  }

  let martLlmCatalogCache: { expiresAt: number; map: Map<string, MartLlmCatalogEntry> } | null =
    null;

  function isMartLlmProvider(provider: ProviderRow): boolean {
    if (provider.preset === 'martllm') return true;
    try {
      return MARTLLM_TRUSTED_HOSTS.has(new URL(provider.base_url).hostname);
    } catch {
      return false;
    }
  }

  async function fetchMartLlmCatalog(): Promise<Map<string, MartLlmCatalogEntry>> {
    const now = Date.now();
    if (martLlmCatalogCache && martLlmCatalogCache.expiresAt > now) {
      return martLlmCatalogCache.map;
    }
    const map = new Map<string, MartLlmCatalogEntry>();
    try {
      const response = await fetch(`${MARTLLM_API_BASE}/api/v1/public/models`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) return map;
      const payload = (await response.json()) as
        | Array<Record<string, unknown>>
        | { models?: Array<Record<string, unknown>>; data?: Array<Record<string, unknown>> };
      const rows = Array.isArray(payload)
        ? payload
        : Array.isArray(payload.models)
          ? payload.models
          : Array.isArray(payload.data)
            ? payload.data
            : [];
      for (const item of rows) {
        const id = typeof item.id === 'string' ? item.id : '';
        if (!id) continue;
        const capsList = Array.isArray(item.capabilities)
          ? item.capabilities.filter((c): c is string => typeof c === 'string')
          : [];
        const inputMods = Array.isArray(item.input_modalities)
          ? item.input_modalities.filter((m): m is string => typeof m === 'string')
          : [];
        const outputMods = Array.isArray(item.output_modalities)
          ? item.output_modalities.filter((m): m is string => typeof m === 'string')
          : [];
        const price7d =
          item.price_7d && typeof item.price_7d === 'object'
            ? (item.price_7d as Record<string, unknown>)
            : null;
        const priceNow =
          item.price_now && typeof item.price_now === 'object'
            ? (item.price_now as Record<string, unknown>)
            : null;
        const inputUsd =
          typeof price7d?.input_usd_per_mtok === 'number'
            ? price7d.input_usd_per_mtok
            : typeof priceNow?.input_usd_per_mtok === 'number'
              ? priceNow.input_usd_per_mtok
              : 0;
        const outputUsd =
          typeof price7d?.output_usd_per_mtok === 'number'
            ? price7d.output_usd_per_mtok
            : typeof priceNow?.output_usd_per_mtok === 'number'
              ? priceNow.output_usd_per_mtok
              : 0;
        map.set(id, {
          id,
          label: typeof item.display_name === 'string' && item.display_name ? item.display_name : id,
          contextWindow:
            typeof item.context_length === 'number' && item.context_length > 0
              ? Math.round(item.context_length)
              : null,
          maxOutputTokens:
            typeof item.max_output_tokens === 'number' && item.max_output_tokens > 0
              ? Math.round(item.max_output_tokens)
              : null,
          capabilities: {
            tools: item.supports_tools === true || capsList.includes('tools'),
            json: capsList.includes('response_format') || capsList.includes('structured_outputs'),
            vision: inputMods.includes('image'),
            embeddings:
              outputMods.includes('embeddings') ||
              capsList.includes('embeddings') ||
              id.toLowerCase().includes('embed'),
          },
          inputCostMicrosPerMtok: Math.max(0, Math.round(inputUsd * 1_000_000)),
          outputCostMicrosPerMtok: Math.max(0, Math.round(outputUsd * 1_000_000)),
        });
      }
      martLlmCatalogCache = { expiresAt: now + 60_000, map };
    } catch {
      // fail-open: never block model creation or refresh
    }
    return map;
  }

  app.post(
    '/llm/providers/martllm/link/start',
    {
      preHandler: operator,
      schema: {
        summary: 'Start MartLLM browser device-link flow',
        tags: ['llm-providers'],
        response: {
          200: objectSchema,
          401: errorSchema,
          403: errorSchema,
          502: errorSchema,
        },
      },
    },
    async () => {
      let response: Response;
      try {
        response = await fetch(`${MARTLLM_API_BASE}/api/v1/cli/link/start`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            client_name: 'SmartFlow Platform',
            client_platform: process.platform,
          }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new AppError(
          'llm_provider_error',
          'MartLLM konnte nicht erreicht werden.',
          502,
        );
      }
      if (!response.ok) {
        throw new AppError(
          'llm_provider_error',
          `MartLLM-Anmeldung fehlgeschlagen (HTTP ${response.status}).`,
          502,
        );
      }
      const data = (await response.json()) as {
        device_code?: string;
        verification_url?: string;
        link_code?: string;
        interval?: number;
        expires_in?: number;
      };
      if (!data.device_code || !data.verification_url) {
        throw new AppError(
          'llm_provider_error',
          'Ungültige Antwort von MartLLM beim Start der Browser-Anmeldung.',
          502,
        );
      }
      return {
        deviceCode: data.device_code,
        verificationUrl: data.verification_url,
        linkCode: data.link_code ?? '',
        interval: Math.max(2, Number(data.interval) || 3),
        expiresIn: Number(data.expires_in) || 900,
      };
    },
  );

  app.post<{ Body: { deviceCode: string; name?: string } }>(
    '/llm/providers/martllm/link/poll',
    {
      preHandler: operator,
      schema: {
        summary: 'Poll MartLLM browser device-link flow and create provider on approval',
        tags: ['llm-providers'],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['deviceCode'],
          properties: {
            deviceCode: { type: 'string', minLength: 1, maxLength: 300 },
            name: { type: 'string', minLength: 1, maxLength: 80 },
          },
        },
        response: {
          200: objectSchema,
          401: errorSchema,
          403: errorSchema,
          502: errorSchema,
        },
      },
    },
    async (request) => {
      const { deviceCode } = request.body;
      let response: Response;
      try {
        response = await fetch(`${MARTLLM_API_BASE}/api/v1/cli/link/poll`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ device_code: deviceCode }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        return { status: 'pending' as const };
      }
      if (response.status === 429) {
        return { status: 'pending' as const };
      }
      if (!response.ok) {
        throw new AppError(
          'llm_provider_error',
          `MartLLM-Statusabfrage fehlgeschlagen (HTTP ${response.status}).`,
          502,
        );
      }
      const poll = (await response.json()) as {
        status?: string;
        api_key?: string;
        base_url?: string;
      };
      if (poll.status === 'denied' || poll.status === 'expired') {
        return { status: poll.status };
      }
      if (poll.status !== 'approved' || !poll.api_key) {
        return { status: 'pending' as const };
      }

      let apiOrigin = MARTLLM_API_BASE;
      if (poll.base_url) {
        try {
          const parsed = new URL(poll.base_url);
          if (parsed.protocol === 'https:' && MARTLLM_TRUSTED_HOSTS.has(parsed.hostname)) {
            apiOrigin = parsed.origin;
          }
        } catch {
          // keep default trusted origin
        }
      }
      const baseUrl = `${apiOrigin}/v1`;
      const name = (request.body.name?.trim() || 'MartLLM').slice(0, 80);
      const now = ctx.now().toISOString();
      const id = newId('llm_p');
      const existingCount = (
        db.prepare('select count(*) as count from llm_provider').get() as { count: number }
      ).count;
      const isDefault = existingCount === 0 ? 1 : 0;

      db.prepare(
        `insert into llm_provider
         (id, name, preset, base_url, chat_path, api_version, auth_style, auth_header,
          api_key_sealed, api_key_updated_at, extra_headers_sealed, extra_header_names,
          timeout_ms, max_retries, rate_limit_per_minute, daily_token_limit,
          monthly_budget_micros, retention_days, allowed_plugins, status, is_default,
          created_at, updated_at, created_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        name,
        'martllm',
        baseUrl,
        '/chat/completions',
        null,
        'bearer',
        'Authorization',
        runtime.sealKey(poll.api_key),
        now,
        null,
        '[]',
        30_000,
        1,
        60,
        0,
        0,
        90,
        null,
        'active',
        isDefault,
        now,
        now,
        request.user?.id ?? 'unknown',
      );
      recordLog('info', 'provider.created', `Provider "${name}" per MartLLM Browser-Login verbunden (${baseUrl}).`, {
        id,
        name,
      });
      return {
        status: 'approved' as const,
        provider: runtime.toProvider(runtime.provider(id) as ProviderRow),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/llm/providers/:id',
    {
      preHandler: operator,
      schema: {
        summary: 'Read one LLM provider',
        tags: ['llm-providers'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: objectSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema },
      },
    },
    async (request) => {
      const row = runtime.provider(request.params.id);
      if (!row) throw new AppError('llm_provider_not_found', 'Provider not found.', 404);
      return runtime.toProvider(row);
    },
  );

  app.patch<{ Params: { id: string }; Body: ProviderBody }>(
    '/llm/providers/:id',
    {
      preHandler: operator,
      schema: {
        summary: 'Update an LLM provider',
        tags: ['llm-providers'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: providerPatchBody,
        response: {
          200: objectSchema,
          401: errorSchema,
          403: errorSchema,
          404: errorSchema,
          422: errorSchema,
        },
      },
    },
    async (request) => {
      const existing = runtime.provider(request.params.id);
      if (!existing) throw new AppError('llm_provider_not_found', 'Provider not found.', 404);
      const body = request.body;
      const originChanged =
        originOf(body.baseUrl ?? existing.base_url) !== originOf(existing.base_url);
      if (
        originChanged &&
        existing.api_key_sealed !== null &&
        (body.authStyle ?? existing.auth_style) !== 'none' &&
        !body.apiKey
      ) {
        // A stored credential belongs to the old host. Reusing it on a new host
        // would hand the secret to whoever controls that host.
        throw new FieldError({
          baseUrl: 'A changed host needs a new API key for this gateway.',
        });
      }
      const draft = validateDraft(
        {
          name: body.name ?? existing.name,
          preset: body.preset ?? existing.preset,
          baseUrl: body.baseUrl ?? existing.base_url,
          chatPath: body.chatPath ?? existing.chat_path,
          apiVersion: body.apiVersion !== undefined ? body.apiVersion : existing.api_version,
          authStyle: body.authStyle ?? existing.auth_style,
          authHeader: body.authHeader !== undefined ? body.authHeader : existing.auth_header,
          apiKey: body.apiKey ?? null,
          extraHeaders: body.extraHeaders ?? null,
          timeoutMs: body.timeoutMs ?? existing.timeout_ms,
          maxRetries: body.maxRetries ?? existing.max_retries,
          rateLimitPerMinute: body.rateLimitPerMinute ?? existing.rate_limit_per_minute,
          dailyTokenLimit: body.dailyTokenLimit ?? existing.daily_token_limit,
          monthlyBudgetMicros: body.monthlyBudgetMicros ?? existing.monthly_budget_micros,
          retentionDays: body.retentionDays ?? existing.retention_days,
          allowedPlugins:
            body.allowedPlugins !== undefined
              ? body.allowedPlugins
              : parseAllowed(existing.allowed_plugins),
          status: body.status ?? existing.status,
        },
        existing.api_key_sealed !== null,
        runtime.allowHttp,
      );

      const now = ctx.now().toISOString();
      const totalProviders = (
        db.prepare('select count(*) as count from llm_provider').get() as { count: number }
      ).count;
      let nextIsDefault = existing.is_default === 1;
      if (body.isDefault === true) {
        db.prepare('update llm_provider set is_default = 0 where id != ?').run(existing.id);
        nextIsDefault = true;
      } else if (body.isDefault === false) {
        nextIsDefault = totalProviders <= 1;
      }
      const extra =
        draft.extraHeaders && Object.keys(draft.extraHeaders).length > 0
          ? validateExtraHeaders(draft.extraHeaders)
          : null;
      db.prepare(
        `update llm_provider set
           name = ?, preset = ?, base_url = ?, chat_path = ?, api_version = ?,
           auth_style = ?, auth_header = ?, api_key_sealed = ?, api_key_updated_at = ?,
           extra_headers_sealed = ?, extra_header_names = ?, timeout_ms = ?, max_retries = ?,
           rate_limit_per_minute = ?, daily_token_limit = ?, monthly_budget_micros = ?,
           retention_days = ?, allowed_plugins = ?, status = ?, is_default = ?, updated_at = ?
         where id = ?`,
      ).run(
        draft.name,
        draft.preset,
        draft.baseUrl,
        draft.chatPath,
        draft.apiVersion,
        draft.authStyle,
        draft.authHeader,
        draft.authStyle === 'none'
          ? null
          : draft.apiKey
            ? runtime.sealKey(draft.apiKey)
            : originChanged
              ? null
              : existing.api_key_sealed,
        draft.authStyle === 'none' ? null : draft.apiKey ? now : existing.api_key_updated_at,
        body.extraHeaders !== undefined
          ? extra
            ? runtime.sealHeaders(body.extraHeaders)
            : null
          : originChanged
            ? null
            : existing.extra_headers_sealed,
        body.extraHeaders !== undefined
          ? JSON.stringify(extra?.names ?? [])
          : originChanged
            ? '[]'
            : existing.extra_header_names,
        draft.timeoutMs,
        draft.maxRetries,
        draft.rateLimitPerMinute,
        draft.dailyTokenLimit,
        draft.monthlyBudgetMicros,
        draft.retentionDays,
        draft.allowedPlugins ? JSON.stringify(draft.allowedPlugins) : null,
        draft.status,
        nextIsDefault ? 1 : 0,
        now,
        existing.id,
      );
      recordLog('info', 'provider.updated', `Provider "${draft.name}" aktualisiert.`, {
        id: existing.id,
        name: draft.name,
      });
      return runtime.toProvider(runtime.provider(existing.id) as ProviderRow);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/llm/providers/:id',
    {
      preHandler: operator,
      schema: {
        summary: 'Delete an LLM provider and its models',
        tags: ['llm-providers'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: {
          204: { type: 'null' },
          401: errorSchema,
          403: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const existing = runtime.provider(request.params.id);
      if (!existing) throw new AppError('llm_provider_not_found', 'Provider not found.', 404);
      // Deleting a provider is always allowed: its models go with it and any
      // purpose that still pointed at one of them is cleared, so the delete never
      // fails on a reference the operator cannot see in the confirmation dialog.
      db.transaction(() => {
        const providerModels = 'select id from llm_model where provider_id = ?';
        db.prepare(
          `update llm_purpose set model_id = null where model_id in (${providerModels})`,
        ).run(existing.id);
        db.prepare(
          `update llm_purpose set fallback_model_id = null where fallback_model_id in (${providerModels})`,
        ).run(existing.id);
        db.prepare('delete from llm_model where provider_id = ?').run(existing.id);
        db.prepare('delete from llm_provider where id = ?').run(existing.id);
        if (existing.is_default === 1) {
          db.prepare(
            `update llm_provider set is_default = 1
              where id = (
                select id from llm_provider
                 order by case when status = 'active' then 0 else 1 end, created_at asc, id asc
                 limit 1
              )`,
          ).run();
        }
      })();
      recordLog('warn', 'provider.deleted', `Provider "${existing.name}" gelöscht.`, {
        id: existing.id,
        name: existing.name,
      });
      reply.code(204).send();
    },
  );

  const testTimes = new Map<string, number>();

  /** Model discovery hits the provider too; one refresh per user per 10 s. */
  const refreshTimes = new Map<string, number>();
  function allowRefresh(userId: string): boolean {
    const now = ctx.now().getTime();
    const last = refreshTimes.get(userId) ?? 0;
    if (now - last < 10_000) return false;
    refreshTimes.set(userId, now);
    if (refreshTimes.size > 1000) {
      for (const [key, stamp] of refreshTimes) {
        if (now - stamp > 60_000) refreshTimes.delete(key);
      }
    }
    return true;
  }

  function buildTestProvider(
    existing: ProviderRow | undefined,
    body: ProviderBody,
  ): { provider: ProviderRow; apiKey: string | null; headers: Record<string, string> } {
    const originChanged =
      existing !== undefined &&
      originOf(body.baseUrl ?? existing.base_url) !== originOf(existing.base_url);
    const draft = validateDraft(
      {
        name: body.name ?? existing?.name ?? 'Draft',
        preset: body.preset ?? existing?.preset ?? 'custom',
        baseUrl: body.baseUrl ?? existing?.base_url ?? '',
        chatPath: body.chatPath ?? existing?.chat_path ?? '/chat/completions',
        apiVersion:
          body.apiVersion !== undefined ? body.apiVersion : (existing?.api_version ?? null),
        authStyle: body.authStyle ?? existing?.auth_style ?? 'bearer',
        authHeader:
          body.authHeader !== undefined ? body.authHeader : (existing?.auth_header ?? null),
        apiKey: body.apiKey ?? null,
        extraHeaders: body.extraHeaders ?? null,
        timeoutMs: body.timeoutMs ?? existing?.timeout_ms ?? 30_000,
        maxRetries: existing?.max_retries ?? 1,
        rateLimitPerMinute: existing?.rate_limit_per_minute ?? 60,
        dailyTokenLimit: existing?.daily_token_limit ?? 0,
        monthlyBudgetMicros: existing?.monthly_budget_micros ?? 0,
        retentionDays: existing?.retention_days ?? 90,
        allowedPlugins: parseAllowed(existing?.allowed_plugins ?? null),
        status: existing?.status ?? 'active',
      },
      existing?.api_key_sealed !== null && existing !== undefined,
      runtime.allowHttp,
    );
    if (
      originChanged &&
      draft.authStyle !== 'none' &&
      !draft.apiKey &&
      existing !== undefined &&
      existing.api_key_sealed !== null
    ) {
      throw new FieldError({
        baseUrl: 'A changed host needs a new API key for this gateway.',
      });
    }
    const provider: ProviderRow = {
      id: existing?.id ?? 'draft',
      name: draft.name,
      preset: draft.preset,
      base_url: draft.baseUrl,
      chat_path: draft.chatPath,
      api_version: draft.apiVersion,
      auth_style: draft.authStyle,
      auth_header: draft.authHeader,
      api_key_sealed:
        draft.authStyle === 'none' || (originChanged && !draft.apiKey)
          ? null
          : (existing?.api_key_sealed ?? null),
      api_key_updated_at: existing?.api_key_updated_at ?? null,
      extra_headers_sealed:
        originChanged && body.extraHeaders === undefined
          ? null
          : (existing?.extra_headers_sealed ?? null),
      extra_header_names: existing?.extra_header_names ?? '[]',
      timeout_ms: draft.timeoutMs,
      max_retries: draft.maxRetries,
      rate_limit_per_minute: draft.rateLimitPerMinute,
      daily_token_limit: draft.dailyTokenLimit,
      monthly_budget_micros: draft.monthlyBudgetMicros,
      retention_days: draft.retentionDays,
      allowed_plugins: existing?.allowed_plugins ?? null,
      status: draft.status,
      is_default: existing?.is_default ?? 0,
      last_test_at: existing?.last_test_at ?? null,
      last_test_status: existing?.last_test_status ?? null,
      last_test_ms: existing?.last_test_ms ?? null,
      created_at: existing?.created_at ?? ctx.now().toISOString(),
      updated_at: existing?.updated_at ?? ctx.now().toISOString(),
      created_by: existing?.created_by ?? 'draft',
    };
    const apiKey =
      draft.apiKey ?? (existing !== undefined && !originChanged ? runtime.openKey(existing) : null);
    const headers =
      body.extraHeaders ??
      (existing !== undefined && !originChanged ? runtime.openHeaders(existing) : {});
    return { provider, apiKey, headers };
  }

  async function runTest(
    request: { user: { id: string } | null; body: ProviderBody },
    existing?: ProviderRow,
  ): Promise<ProviderTestResult> {
    const userKey = request.user?.id ?? 'unknown';
    const now = runtime.now().getTime();
    const last = testTimes.get(userKey) ?? 0;
    if (now - last < TEST_INTERVAL_MS) {
      throw new AppError(
        'llm_test_rate_limited',
        'Please wait a few seconds before testing again.',
        429,
      );
    }
    testTimes.set(userKey, now);

    const { provider, apiKey, headers } = buildTestProvider(existing, request.body);
    const started = Date.now();
    try {
      const models = await listModels(
        provider,
        apiKey,
        headers,
        Math.min(5000, provider.timeout_ms),
      );
      const latencyMs = Date.now() - started;
      if (existing) {
        runtime.recordTest(existing.id, 'ok', latencyMs);
      }
      recordLog(
        'info',
        'provider.test',
        `Verbindungstest erfolgreich (${latencyMs} ms, ${models.length} Modelle).`,
        { id: existing?.id ?? null, name: existing?.name ?? provider.name },
      );
      return {
        ok: true,
        latencyMs,
        models: models.map((model) => ({ modelKey: model.modelKey })),
      };
    } catch (error) {
      const latencyMs = Date.now() - started;
      if (!(error instanceof UpstreamError)) throw error;
      if (existing) runtime.recordTest(existing.id, error.reason, latencyMs);
      recordLog(
        'error',
        'provider.test',
        `Verbindungstest fehlgeschlagen (${error.reason}, ${latencyMs} ms): ${error.message}`,
        { id: existing?.id ?? null, name: existing?.name ?? provider.name },
      );
      return {
        ok: false,
        latencyMs,
        code: `llm_provider_${error.reason}`,
        message: error.message,
      };
    }
  }

  app.post<{ Body: ProviderBody & { providerId?: string } }>(
    '/llm/providers/test',
    {
      preHandler: operator,
      schema: {
        summary: 'Test a provider draft without saving it',
        tags: ['llm-providers'],
        body: {
          ...providerBody,
          required: [],
          properties: {
            ...providerBody.properties,
            providerId: { type: 'string' },
          },
        },
        response: {
          200: objectSchema,
          401: errorSchema,
          403: errorSchema,
          422: errorSchema,
          429: errorSchema,
        },
      },
    },
    async (request) => {
      const existing = request.body.providerId
        ? runtime.provider(request.body.providerId)
        : undefined;
      if (request.body.providerId && !existing) {
        throw new AppError('llm_provider_not_found', 'Provider not found.', 404);
      }
      return runTest({ user: request.user, body: request.body }, existing);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/llm/providers/:id/test',
    {
      preHandler: operator,
      schema: {
        summary: 'Test a stored provider',
        tags: ['llm-providers'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: {
          200: objectSchema,
          401: errorSchema,
          403: errorSchema,
          404: errorSchema,
          429: errorSchema,
        },
      },
    },
    async (request) => {
      const existing = runtime.provider(request.params.id);
      if (!existing) throw new AppError('llm_provider_not_found', 'Provider not found.', 404);
      return runTest({ user: request.user, body: {} }, existing);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/llm/providers/:id/models',
    {
      preHandler: operator,
      schema: {
        summary: 'List models of one provider',
        tags: ['llm-providers'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: objectSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema },
      },
    },
    async (request) => {
      const provider = runtime.provider(request.params.id);
      if (!provider) throw new AppError('llm_provider_not_found', 'Provider not found.', 404);
      const rows = db
        .prepare(
          'select * from llm_model where provider_id = ? order by label asc, id asc',
        )
        .all(provider.id) as ModelRow[];
      if (rows.length === 1 && rows[0] && rows[0].is_default === 0) {
        db.prepare('update llm_model set is_default = 1 where id = ?').run(rows[0].id);
        rows[0].is_default = 1;
      }
      return { items: rows.map(toModel) };
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/llm/providers/:id/models',
    {
      preHandler: operator,
      schema: {
        summary: 'Add a model to a provider',
        tags: ['llm-providers'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: modelBody,
        response: {
          201: objectSchema,
          401: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
          422: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const provider = runtime.provider(request.params.id);
      if (!provider) throw new AppError('llm_provider_not_found', 'Provider not found.', 404);
      const body = request.body;
      const modelKey = String(body.modelKey ?? '').trim();
      if (!modelKey) throw new FieldError({ modelKey: 'Please enter the model id.' });
      if (modelKey === '.' || modelKey === '..') {
        throw new FieldError({ modelKey: 'The model id must not be a path segment.' });
      }
      const requestedDefault = body.isDefault === true;
      const rawCaps = body.capabilities as Partial<Capabilities> | undefined;
      const catalogEntry = isMartLlmProvider(provider)
        ? (await fetchMartLlmCatalog()).get(modelKey)
        : undefined;
      const resolvedCapabilities: Capabilities = {
        tools: rawCaps?.tools ?? catalogEntry?.capabilities.tools ?? false,
        json: rawCaps?.json ?? catalogEntry?.capabilities.json ?? false,
        vision: rawCaps?.vision ?? catalogEntry?.capabilities.vision ?? false,
        embeddings: rawCaps?.embeddings ?? catalogEntry?.capabilities.embeddings ?? false,
      };
      const id = newId('llm_m');
      try {
        db.transaction(() => {
          const isDefault = requestedDefault || runtime.modelCount(provider.id) === 0;
          if (isDefault) {
            db.prepare('update llm_model set is_default = 0 where provider_id = ?').run(
              provider.id,
            );
          }
          db.prepare(
            `insert into llm_model
             (id, provider_id, model_key, label, context_window, max_output_tokens, capabilities,
              input_cost_micros_per_mtok, output_cost_micros_per_mtok, is_default, source,
              status, created_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          provider.id,
          modelKey,
          String(body.label ?? catalogEntry?.label ?? modelKey).trim() || modelKey,
          body.contextWindow ?? catalogEntry?.contextWindow ?? null,
          body.maxOutputTokens ?? catalogEntry?.maxOutputTokens ?? null,
          JSON.stringify(resolvedCapabilities),
          body.inputCostMicrosPerMtok ?? catalogEntry?.inputCostMicrosPerMtok ?? 0,
          body.outputCostMicrosPerMtok ?? catalogEntry?.outputCostMicrosPerMtok ?? 0,
          isDefault ? 1 : 0,
            body.source ?? 'manual',
            body.status ?? 'active',
            ctx.now().toISOString(),
          );
        })();
      } catch (error) {
        if (isUniqueError(error)) {
          throw new AppError('llm_model_exists', 'This model already exists.', 409);
        }
        throw error;
      }
      reply.code(201);
      return toModel(runtime.model(id) as ModelRow);
    },
  );

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/llm/models/:id',
    {
      preHandler: operator,
      schema: {
        summary: 'Update a model',
        tags: ['llm-providers'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: modelPatchBody,
        response: {
          200: objectSchema,
          401: errorSchema,
          403: errorSchema,
          404: errorSchema,
          422: errorSchema,
        },
      },
    },
    async (request) => {
      const existing = runtime.model(request.params.id);
      if (!existing) throw new AppError('llm_model_not_found', 'Model not found.', 404);
      const body = request.body;
      const capabilities =
        body.capabilities !== undefined
          ? {
              tools: (body.capabilities as Capabilities).tools === true,
              json: (body.capabilities as Capabilities).json === true,
              vision: (body.capabilities as Capabilities).vision === true,
              embeddings: (body.capabilities as Capabilities).embeddings === true,
            }
          : undefined;
      const isDefault = body.isDefault === true;
      db.transaction(() => {
        if (isDefault) {
          db.prepare('update llm_model set is_default = 0 where provider_id = ?').run(
            existing.provider_id,
          );
        }
        db.prepare(
          `update llm_model set label = ?, context_window = ?, max_output_tokens = ?,
             capabilities = ?, input_cost_micros_per_mtok = ?, output_cost_micros_per_mtok = ?,
             is_default = ?, status = ? where id = ?`,
        ).run(
          body.label !== undefined ? String(body.label).trim() || existing.label : existing.label,
          body.contextWindow !== undefined ? body.contextWindow : existing.context_window,
          body.maxOutputTokens !== undefined ? body.maxOutputTokens : existing.max_output_tokens,
          capabilities !== undefined ? JSON.stringify(capabilities) : existing.capabilities,
          body.inputCostMicrosPerMtok ?? existing.input_cost_micros_per_mtok,
          body.outputCostMicrosPerMtok ?? existing.output_cost_micros_per_mtok,
          body.isDefault !== undefined ? (isDefault ? 1 : 0) : existing.is_default,
          body.status ?? existing.status,
          existing.id,
        );
      })();
      return toModel(runtime.model(existing.id) as ModelRow);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/llm/models/:id',
    {
      preHandler: operator,
      schema: {
        summary: 'Delete an unused model',
        tags: ['llm-providers'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: {
          204: { type: 'null' },
          401: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const existing = runtime.model(request.params.id);
      if (!existing) throw new AppError('llm_model_not_found', 'Model not found.', 404);
      const used = db
        .prepare(
          'select count(*) as count from llm_purpose where model_id = ? or fallback_model_id = ?',
        )
        .get(existing.id, existing.id) as { count: number };
      if (used.count > 0) {
        throw new AppError(
          'llm_model_in_use',
          'A purpose still uses this model. Reassign it first.',
          409,
        );
      }
      db.transaction(() => {
        db.prepare('delete from llm_model where id = ?').run(existing.id);
        const remaining = db
          .prepare('select id from llm_model where provider_id = ?')
          .all(existing.provider_id) as Array<{ id: string }>;
        if (remaining.length === 1 && remaining[0]) {
          db.prepare('update llm_model set is_default = 1 where id = ?').run(remaining[0].id);
        }
      })();
      reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    '/llm/providers/:id/models/refresh',
    {
      preHandler: operator,
      schema: {
        summary: 'Discover models without saving them',
        tags: ['llm-providers'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: {
          200: objectSchema,
          401: errorSchema,
          403: errorSchema,
          404: errorSchema,
          429: errorSchema,
          502: errorSchema,
        },
      },
    },
    async (request) => {
      if (!allowRefresh(request.user?.id ?? 'unknown')) {
        throw new AppError(
          'llm_refresh_rate_limited',
          'Please wait a few seconds before refreshing again.',
          429,
        );
      }
      const provider = runtime.provider(request.params.id);
      if (!provider) throw new AppError('llm_provider_not_found', 'Provider not found.', 404);
      const key = runtime.openKey(provider);
      const headers = runtime.openHeaders(provider);
      try {
        const models = await listModels(
          provider,
          key,
          headers,
          Math.min(5000, provider.timeout_ms),
        );
        const existingRows = db
          .prepare('select id, model_key from llm_model where provider_id = ?')
          .all(provider.id) as Array<{ id: string; model_key: string }>;
        const existing = new Set(existingRows.map((row) => row.model_key));
        let enrichedCount = 0;
        if (isMartLlmProvider(provider) && existingRows.length > 0) {
          const catalog = await fetchMartLlmCatalog();
          const updateModel = db.prepare(
            `update llm_model
                set context_window = coalesce(?, context_window),
                    max_output_tokens = coalesce(?, max_output_tokens),
                    capabilities = ?,
                    input_cost_micros_per_mtok = ?,
                    output_cost_micros_per_mtok = ?
              where id = ?`,
          );
          for (const row of existingRows) {
            const entry = catalog.get(row.model_key);
            if (!entry) continue;
            updateModel.run(
              entry.contextWindow,
              entry.maxOutputTokens,
              JSON.stringify(entry.capabilities),
              entry.inputCostMicrosPerMtok,
              entry.outputCostMicrosPerMtok,
              row.id,
            );
            enrichedCount += 1;
          }
        }
        const discovered = models.filter((model) => !existing.has(model.modelKey));
        recordLog(
          'info',
          'models.refresh',
          `${models.length} Modelle vom Provider geladen (${discovered.length} neu${enrichedCount > 0 ? `, ${enrichedCount} Preise & Capabilities aktualisiert` : ''}).`,
          { id: provider.id, name: provider.name },
        );
        return { items: discovered };
      } catch (error) {
        if (!(error instanceof UpstreamError)) throw error;
        recordLog(
          'error',
          'models.refresh',
          `Modelle laden fehlgeschlagen (${error.reason}): ${error.message}`,
          { id: provider.id, name: provider.name },
        );
        throw new AppError('llm_provider_error', 'The provider did not return its models.', 502, {
          reason: error.reason,
        });
      }
    },
  );

  const purposeRows = (): PurposeRow[] =>
    db.prepare('select * from llm_purpose order by purpose').all() as PurposeRow[];

  function purposeRefs(row: PurposeRow): {
    model: ReturnType<typeof toPurposeModelRef> | null;
    fallbackModel: ReturnType<typeof toPurposeModelRef> | null;
  } {
    const model = row.model_id ? runtime.model(row.model_id) : undefined;
    const modelProvider = model ? runtime.provider(model.provider_id) : undefined;
    const fallback = row.fallback_model_id ? runtime.model(row.fallback_model_id) : undefined;
    const fallbackProvider = fallback ? runtime.provider(fallback.provider_id) : undefined;
    return {
      model: model && modelProvider ? toPurposeModelRef(model, modelProvider) : null,
      fallbackModel:
        fallback && fallbackProvider ? toPurposeModelRef(fallback, fallbackProvider) : null,
    };
  }

  function purposeDto(row: PurposeRow): ReturnType<typeof toPurpose> {
    const since = new Date(ctx.now().getTime() - 30 * 86_400_000).toISOString();
    const calls = (
      db
        .prepare(
          `select count(*) as count from llm_usage
           where purpose = ? and status = 'ok' and created_at >= ?`,
        )
        .get(row.purpose, since) as { count: number }
    ).count;
    const refs = purposeRefs(row);
    return toPurpose(row, refs.model, refs.fallbackModel, calls);
  }

  function ensureUsableModel(modelId: string | null | undefined): ModelRow | null {
    if (!modelId) return null;
    const model = runtime.model(modelId);
    if (!model) throw new AppError('llm_model_not_found', 'Model not found.', 404);
    const provider = runtime.provider(model.provider_id);
    if (!provider) throw new AppError('llm_provider_not_found', 'Provider not found.', 404);
    if (model.status !== 'active' || provider.status !== 'active') {
      throw new AppError('llm_provider_disabled', 'The model or its provider is disabled.', 409);
    }
    return model;
  }

  app.get(
    '/llm/purposes',
    {
      preHandler: operator,
      schema: {
        summary: 'List purposes and their models',
        tags: ['llm-providers'],
        response: { 200: objectSchema, 401: errorSchema, 403: errorSchema },
      },
    },
    async () => ({ items: purposeRows().map(purposeDto) }),
  );

  app.post<{
    Body: {
      purpose?: string;
      modelId?: string | null;
      fallbackModelId?: string | null;
      description?: string | null;
    };
  }>(
    '/llm/purposes',
    {
      preHandler: operator,
      schema: {
        summary: 'Create a purpose',
        tags: ['llm-providers'],
        body: purposeBody,
        response: {
          201: objectSchema,
          401: errorSchema,
          403: errorSchema,
          409: errorSchema,
          422: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const purpose = validatePurposeName(request.body.purpose ?? '');
      ensureUsableModel(request.body.modelId);
      ensureUsableModel(request.body.fallbackModelId);
      try {
        db.prepare(
          `insert into llm_purpose (purpose, model_id, fallback_model_id, description, updated_at, updated_by)
           values (?, ?, ?, ?, ?, ?)`,
        ).run(
          purpose,
          request.body.modelId ?? null,
          request.body.fallbackModelId ?? null,
          request.body.description ?? null,
          ctx.now().toISOString(),
          request.user?.id ?? 'unknown',
        );
      } catch (error) {
        if (isUniqueError(error)) {
          throw new AppError('llm_purpose_exists', 'This purpose already exists.', 409);
        }
        throw error;
      }
      reply.code(201);
      return purposeDto(runtime.purpose(purpose) as PurposeRow);
    },
  );

  app.patch<{
    Params: { purpose: string };
    Body: { modelId?: string | null; fallbackModelId?: string | null; description?: string | null };
  }>(
    '/llm/purposes/:purpose',
    {
      preHandler: operator,
      schema: {
        summary: 'Assign models to a purpose',
        tags: ['llm-providers'],
        params: {
          type: 'object',
          required: ['purpose'],
          properties: { purpose: { type: 'string' } },
        },
        body: purposePatchBody,
        response: {
          200: objectSchema,
          401: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
          422: errorSchema,
        },
      },
    },
    async (request) => {
      const existing = runtime.purpose(request.params.purpose);
      if (!existing) throw new AppError('llm_purpose_not_found', 'Purpose not found.', 404);
      ensureUsableModel(request.body.modelId);
      ensureUsableModel(request.body.fallbackModelId);
      db.prepare(
        `update llm_purpose set model_id = ?, fallback_model_id = ?, description = ?,
           updated_at = ?, updated_by = ? where purpose = ?`,
      ).run(
        request.body.modelId !== undefined ? request.body.modelId : existing.model_id,
        request.body.fallbackModelId !== undefined
          ? request.body.fallbackModelId
          : existing.fallback_model_id,
        request.body.description !== undefined ? request.body.description : existing.description,
        ctx.now().toISOString(),
        request.user?.id ?? 'unknown',
        existing.purpose,
      );
      return purposeDto(runtime.purpose(existing.purpose) as PurposeRow);
    },
  );

  app.delete<{ Params: { purpose: string } }>(
    '/llm/purposes/:purpose',
    {
      preHandler: operator,
      schema: {
        summary: 'Delete a purpose; usage history keeps the name',
        tags: ['llm-providers'],
        params: {
          type: 'object',
          required: ['purpose'],
          properties: { purpose: { type: 'string' } },
        },
        response: {
          204: { type: 'null' },
          401: errorSchema,
          403: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const existing = runtime.purpose(request.params.purpose);
      if (!existing) throw new AppError('llm_purpose_not_found', 'Purpose not found.', 404);
      db.prepare('delete from llm_purpose where purpose = ?').run(existing.purpose);
      reply.code(204).send();
    },
  );

  app.get<{
    Querystring: {
      days?: string;
      caller?: string;
      purpose?: string;
      status?: 'ok' | 'error';
      providerId?: string;
      limit?: string;
      cursor?: string;
    };
  }>(
    '/llm/usage',
    {
      preHandler: operator,
      schema: {
        summary: 'List LLM usage records',
        tags: ['llm-providers'],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            days: { type: 'string' },
            caller: { type: 'string', maxLength: 80 },
            purpose: { type: 'string', maxLength: 80 },
            status: { type: 'string', enum: ['ok', 'error'] },
            providerId: { type: 'string' },
            limit: { type: 'string' },
            cursor: { type: 'string' },
          },
        },
        response: { 200: objectSchema, 401: errorSchema, 403: errorSchema },
      },
    },
    async (request) => {
      const limit = parseLimit(request.query.limit);
      const days = readInt(request.query.days, 30, 1, 365);
      const since = new Date(ctx.now().getTime() - days * 86_400_000).toISOString();
      const where = ['created_at >= ?'];
      const params: unknown[] = [since];
      if (request.query.caller) {
        where.push('caller = ?');
        params.push(request.query.caller);
      }
      if (request.query.purpose) {
        where.push('purpose = ?');
        params.push(request.query.purpose);
      }
      if (request.query.status) {
        where.push('status = ?');
        params.push(request.query.status);
      }
      if (request.query.providerId) {
        where.push('provider_id = ?');
        params.push(request.query.providerId);
      }
      const filter = `where ${where.join(' and ')}`;
      const total = (
        db.prepare(`select count(*) as count from llm_usage ${filter}`).get(...params) as {
          count: number;
        }
      ).count;

      let cursor = null;
      if (request.query.cursor) {
        cursor = decodeCursor(request.query.cursor);
        if (!cursor) throw new AppError('invalid_cursor', 'The cursor is invalid.', 400);
      }
      const pageWhere = [...where];
      const pageParams = [...params];
      if (cursor) {
        pageWhere.push('(created_at < ? or (created_at = ? and id < ?))');
        pageParams.push(cursor.created_at, cursor.created_at, cursor.id);
      }
      const rows = db
        .prepare(
          `select * from llm_usage where ${pageWhere.join(' and ')}
           order by created_at desc, id desc limit ?`,
        )
        .all(...pageParams, limit + 1) as UsageRow[];
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);
      return {
        items: page.map(toUsage),
        total,
        nextCursor:
          hasMore && last ? encodeCursor({ created_at: last.created_at, id: last.id }) : null,
      };
    },
  );

  app.get<{ Querystring: { days?: string } }>(
    '/llm/usage/summary',
    {
      preHandler: operator,
      schema: {
        summary: 'Aggregate LLM usage',
        tags: ['llm-providers'],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { days: { type: 'string' } },
        },
        response: { 200: objectSchema, 401: errorSchema, 403: errorSchema },
      },
    },
    async (request) => {
      const days = readInt(request.query.days, 30, 1, 365);
      const since = new Date(ctx.now().getTime() - days * 86_400_000).toISOString();
      const totals = db
        .prepare(
          `select
             count(*) as calls,
             coalesce(sum(case when status = 'ok' then 1 else 0 end), 0) as ok,
             coalesce(sum(case when status = 'error' then 1 else 0 end), 0) as errors,
             coalesce(sum(coalesce(input_tokens, 0)), 0) as input_tokens,
             coalesce(sum(coalesce(output_tokens, 0)), 0) as output_tokens,
             coalesce(sum(cost_micros), 0) as cost_micros
           from llm_usage where created_at >= ?`,
        )
        .get(since) as {
        calls: number;
        ok: number;
        errors: number;
        input_tokens: number;
        output_tokens: number;
        cost_micros: number;
      };
      const byCaller = db
        .prepare(
          `select caller, count(*) as calls,
             coalesce(sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)), 0) as tokens,
             coalesce(sum(cost_micros), 0) as cost_micros
           from llm_usage where created_at >= ? group by caller order by calls desc`,
        )
        .all(since) as Array<{
        caller: string;
        calls: number;
        tokens: number;
        cost_micros: number;
      }>;
      const byProvider = db
        .prepare(
          `select u.provider_id, p.name as provider_name, count(*) as calls,
             coalesce(sum(u.cost_micros), 0) as cost_micros
           from llm_usage u left join llm_provider p on p.id = u.provider_id
           where u.created_at >= ? group by u.provider_id, p.name order by calls desc`,
        )
        .all(since) as Array<{
        provider_id: string | null;
        provider_name: string | null;
        calls: number;
        cost_micros: number;
      }>;
      const byPurpose = db
        .prepare(
          `select purpose, count(*) as calls, coalesce(sum(cost_micros), 0) as cost_micros
           from llm_usage where created_at >= ? group by purpose order by calls desc`,
        )
        .all(since) as Array<{ purpose: string; calls: number; cost_micros: number }>;
      return {
        days,
        calls: totals.calls,
        ok: totals.ok,
        errors: totals.errors,
        inputTokens: totals.input_tokens,
        outputTokens: totals.output_tokens,
        costMicros: totals.cost_micros,
        byCaller: byCaller.map((row) => ({
          caller: row.caller,
          calls: row.calls,
          tokens: row.tokens,
          costMicros: row.cost_micros,
        })),
        byProvider: byProvider.map((row) => ({
          providerId: row.provider_id,
          providerName: row.provider_name,
          calls: row.calls,
          costMicros: row.cost_micros,
        })),
        byPurpose: byPurpose.map((row) => ({
          purpose: row.purpose,
          calls: row.calls,
          costMicros: row.cost_micros,
        })),
      };
    },
  );

  registerInternalRoutes(app, runtime);
}

function parseAllowed(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return null;
    return value.filter((item): item is string => typeof item === 'string');
  } catch {
    return null;
  }
}

export default { manifest, register };
