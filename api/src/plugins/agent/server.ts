import type {
  AgentSourceInfo,
  LlmMessage,
  LlmRequest,
  LlmToolDefinition,
} from '../../shared/contract.ts';
import type { PluginContext } from '../../kernel/context.ts';
import { AppError } from '../../kernel/errors.ts';
import { decodeCursor, encodeCursor } from '../../kernel/cursor.ts';
import { newId } from '../../kernel/ids.ts';
import { ArgumentError, validateArguments } from '../../kernel/agent-args.ts';
import type { AgentConfig } from '../../kernel/config.ts';
import { RateLimiter } from './limits.ts';
import { SYSTEM_PROMPT } from './prompt.ts';
import { createProvider, withTimeout, type LlmProvider, type ProviderState } from './provider.ts';
import { manifest } from './manifest.ts';

/** A tool result above this size is cut before it reaches the model. */
const MAX_RESULT_BYTES = 4_096;
/** Total source calls per question, across all model rounds. */
const MAX_SOURCE_CALLS = 8;
/** One source call may not take longer than this. */
const SOURCE_TIMEOUT_MS = 5_000;
/** Daily retention sweep; `unref` keeps the process free to exit. */
const RETENTION_SWEEP_MS = 24 * 60 * 60 * 1000;

const errorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        reason: { type: 'string' },
        fields: { type: 'object', additionalProperties: { type: 'string' } },
      },
    },
  },
} as const;

const sourceInfoSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'label', 'description'],
  properties: {
    id: { type: 'string' },
    label: { type: 'string' },
    description: { type: 'string' },
    href: { type: 'string' },
  },
} as const;

const statusSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['configured', 'provider', 'model', 'reachable', 'retentionDays', 'limits', 'sources'],
  properties: {
    configured: { type: 'boolean' },
    provider: { type: ['string', 'null'] },
    model: { type: ['string', 'null'] },
    reachable: { type: 'boolean' },
    retentionDays: { type: 'integer' },
    limits: {
      type: 'object',
      additionalProperties: false,
      required: ['perMinute', 'perDay'],
      properties: {
        perMinute: { type: 'integer' },
        perDay: { type: 'integer' },
      },
    },
    sources: { type: 'array', items: sourceInfoSchema },
  },
} as const;

const stepSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['seq', 'source', 'status', 'durationMs'],
  properties: {
    seq: { type: 'integer' },
    source: { type: 'string' },
    status: { type: 'string', enum: ['ok', 'error'] },
    durationMs: { type: 'integer' },
    errorCode: { type: 'string' },
    truncated: { type: 'boolean' },
  },
} as const;

const runSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'question', 'status', 'createdAt'],
  properties: {
    id: { type: 'string' },
    question: { type: 'string' },
    answer: { type: ['string', 'null'] },
    status: { type: 'string', enum: ['ok', 'error'] },
    errorCode: { type: ['string', 'null'] },
    model: { type: ['string', 'null'] },
    durationMs: { type: ['integer', 'null'] },
    createdAt: { type: 'string' },
    finishedAt: { type: ['string', 'null'] },
    steps: { type: 'array', items: stepSchema },
  },
} as const;

const askResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['run', 'sources', 'truncated'],
  properties: {
    run: runSchema,
    sources: { type: 'array', items: sourceInfoSchema },
    truncated: { type: 'boolean' },
  },
} as const;

const listSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'total', 'nextCursor'],
  properties: {
    items: { type: 'array', items: runSchema },
    total: { type: 'integer' },
    nextCursor: { type: ['string', 'null'] },
  },
} as const;

interface RunRow {
  id: string;
  question: string;
  answer: string | null;
  status: 'ok' | 'error';
  error_code: string | null;
  model: string | null;
  duration_ms: number | null;
  created_at: string;
  finished_at: string | null;
}

interface StepRow {
  seq: number;
  source: string;
  status: 'ok' | 'error';
  duration_ms: number;
  error_code: string | null;
  truncated: number;
}

/** A source id is not a valid tool name; the mapping is lossless and local. */
function toolNameFor(sourceId: string): string {
  return sourceId.replace(/[^a-zA-Z0-9_-]/g, '__');
}

function sourceIdFor(tools: Map<string, string>, toolName: string): string | null {
  return tools.get(toolName) ?? null;
}

export function register(ctx: PluginContext): void {
  const { app, db, log } = ctx;
  const config: AgentConfig = ctx.config.agent;

  const provider: LlmProvider = createProvider(ctx, config);
  const limiter = new RateLimiter(config.perMinute, config.perDay, () => ctx.now());

  ctx.migrate([
    {
      version: 1,
      up(database) {
        database.exec(`
          create table agent_runs (
            id text primary key,
            user_id text not null,
            question text not null,
            answer text,
            status text not null check (status in ('ok','error')),
            error_code text,
            model text,
            duration_ms integer,
            created_at text not null,
            finished_at text
          );
          create index agent_runs_created on agent_runs(created_at, id);

          create table agent_steps (
            id text primary key,
            run_id text not null references agent_runs(id) on delete cascade,
            seq integer not null,
            source text not null,
            args text not null,
            status text not null check (status in ('ok','error')),
            duration_ms integer not null,
            result_bytes integer,
            truncated integer not null default 0,
            error_code text
          );
          create index agent_steps_run on agent_steps(run_id, seq);
        `);
      },
    },
    {
      version: 2,
      up(database) {
        database.exec(`
          create table agent_settings (
            id text primary key,
            provider_id text,
            model_id text,
            updated_at text not null
          );
        `);
      },
    },
  ]);

  function loadSettings(): { providerId: string | null; modelId: string | null } {
    const row = db
      .prepare('select provider_id, model_id from agent_settings where id = ?')
      .get('default') as { provider_id: string | null; model_id: string | null } | undefined;
    return {
      providerId: row?.provider_id ?? null,
      modelId: row?.model_id ?? null,
    };
  }

  // The agent describes its own surface as a source, so "what can I ask?" is
  // answerable from data rather than from prompt text the model could invent.
  ctx.provideAgentSource({
    id: 'agent.sources',
    readOnly: true,
    label: 'Datenquellen',
    description: 'Die freigegebenen Datenquellen des Agenten mit Zweck und Argumenten.',
    args: { type: 'object', additionalProperties: false, properties: {} },
    run: async () =>
      ctx.agentSources().map((source) => ({
        id: source.id,
        label: source.label,
        description: source.description,
        args: source.args,
      })),
  });

  const sourceInfos = (): AgentSourceInfo[] =>
    ctx.agentSources().map((source) => ({
      id: source.id,
      label: source.label,
      description: source.description,
      ...(source.href ? { href: source.href } : {}),
    }));

  /** Always asks the provider plugin; a cached "no" would hide a fixed setup. */
  async function providerState(): Promise<ProviderState> {
    return await provider.status(loadSettings());
  }

  function pruneOldRuns(): void {
    try {
      const cutoff = new Date(
        ctx.now().getTime() - config.retentionDays * 24 * 60 * 60 * 1000,
      ).toISOString();
      const removed = db.prepare('delete from agent_runs where created_at < ?').run(cutoff);
      if (removed.changes > 0) {
        log.info({ count: removed.changes, cutoff }, 'agent: removed expired runs');
      }
    } catch (error) {
      // A busy or closing database must not take the process down with it.
      log.warn({ err: error }, 'agent: retention sweep failed');
    }
  }

  pruneOldRuns();
  const sweep = setInterval(pruneOldRuns, RETENTION_SWEEP_MS);
  // A timer must never keep the API process alive during shutdown.
  if (typeof sweep.unref === 'function') sweep.unref();
  app.addHook('onClose', async () => clearInterval(sweep));

  const insertRun = db.prepare(
    `insert into agent_runs (id, user_id, question, status, error_code, created_at)
     values (?, ?, ?, 'error', 'agent_incomplete', ?)`,
  );
  const finishRun = db.prepare(
    `update agent_runs set answer = ?, status = ?, error_code = ?, model = ?, duration_ms = ?,
     finished_at = ? where id = ?`,
  );
  const insertStep = db.prepare(
    `insert into agent_steps (id, run_id, seq, source, args, status, duration_ms, result_bytes,
     truncated, error_code) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  function runToJson(row: RunRow, steps: StepRow[] = []) {
    return {
      id: row.id,
      question: row.question,
      answer: row.answer,
      status: row.status,
      errorCode: row.error_code,
      model: row.model,
      durationMs: row.duration_ms,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
      steps: steps.map((step) => ({
        seq: step.seq,
        source: step.source,
        status: step.status,
        durationMs: step.duration_ms,
        ...(step.error_code ? { errorCode: step.error_code } : {}),
        truncated: step.truncated === 1,
      })),
    };
  }

  const stepsFor = (runId: string): StepRow[] =>
    db
      .prepare(
        `select seq, source, status, duration_ms, error_code, truncated from agent_steps
         where run_id = ? order by seq`,
      )
      .all(runId) as StepRow[];

  /** One query for a whole page instead of one per run. */
  const stepsForRuns = (runIds: string[]): Map<string, StepRow[]> => {
    const byRun = new Map<string, StepRow[]>(runIds.map((id) => [id, []]));
    if (runIds.length === 0) return byRun;
    const rows = db
      .prepare(
        `select run_id, seq, source, status, duration_ms, error_code, truncated from agent_steps
         where run_id in (${runIds.map(() => '?').join(', ')}) order by run_id, seq`,
      )
      .all(...runIds) as (StepRow & { run_id: string })[];
    for (const { run_id: runId, ...step } of rows) byRun.get(runId)?.push(step);
    return byRun;
  };

  app.get(
    '/agent/status',
    {
      preHandler: app.requireRole('operator'),
      schema: {
        summary: 'Whether the agent can answer, and what it may read',
        tags: ['agent'],
        response: { 200: statusSchema, 401: errorSchema, 403: errorSchema },
      },
    },
    async () => {
      const state = await providerState();
      return {
        configured: state.configured,
        provider: state.provider,
        model: state.model,
        reachable: state.reachable,
        retentionDays: config.retentionDays,
        limits: { perMinute: config.perMinute, perDay: config.perDay },
        sources: sourceInfos(),
      };
    },
  );

  app.get(
    '/agent/settings',
    {
      preHandler: app.requireRole('operator'),
      schema: {
        summary: 'Read selected LLM provider and model for the chat plugin',
        tags: ['agent'],
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['providerId', 'modelId'],
            properties: {
              providerId: { type: ['string', 'null'] },
              modelId: { type: ['string', 'null'] },
            },
          },
          401: errorSchema,
          403: errorSchema,
        },
      },
    },
    async () => loadSettings(),
  );

  app.patch<{ Body: { providerId?: string | null; modelId?: string | null } }>(
    '/agent/settings',
    {
      preHandler: app.requireRole('operator'),
      schema: {
        summary: 'Save selected LLM provider and model for the chat plugin',
        tags: ['agent'],
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            providerId: { type: ['string', 'null'], maxLength: 80 },
            modelId: { type: ['string', 'null'], maxLength: 80 },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['providerId', 'modelId'],
            properties: {
              providerId: { type: ['string', 'null'] },
              modelId: { type: ['string', 'null'] },
            },
          },
          401: errorSchema,
          403: errorSchema,
        },
      },
    },
    async (request) => {
      const current = loadSettings();
      const providerId =
        request.body.providerId !== undefined
          ? request.body.providerId?.trim() || null
          : current.providerId;
      const modelId =
        request.body.modelId !== undefined
          ? request.body.modelId?.trim() || null
          : current.modelId;
      const now = ctx.now().toISOString();
      db.prepare(
        `insert into agent_settings (id, provider_id, model_id, updated_at)
         values ('default', ?, ?, ?)
         on conflict(id) do update set
           provider_id = excluded.provider_id,
           model_id = excluded.model_id,
           updated_at = excluded.updated_at`,
      ).run(providerId, providerId ? modelId : null, now);
      return loadSettings();
    },
  );

  app.post<{ Body: { question?: string } }>(
    '/agent/ask',
    {
      preHandler: app.requireRole('operator'),
      schema: {
        summary: 'Ask the agent a question; it reads registered sources only',
        tags: ['agent'],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['question'],
          properties: { question: { type: 'string', minLength: 1, maxLength: 1_000 } },
        },
        response: {
          200: askResponseSchema,
          401: errorSchema,
          403: errorSchema,
          422: errorSchema,
          429: errorSchema,
          502: errorSchema,
          503: errorSchema,
          504: errorSchema,
        },
      },
    },
    async (request) => {
      const question = (request.body.question ?? '').trim();
      if (question.length === 0) {
        throw new AppError('validation_failed', 'Please enter a question.', 422, {
          fields: { question: 'Please enter a question.' },
        });
      }
      const operator = request.user;
      // `requireRole` already answered 401 for a missing session; this keeps
      // the type honest without asserting it away.
      if (!operator) throw new AppError('unauthorized', 'Sign in required.', 401);

      const state = await providerState();
      if (!state.configured) {
        throw new AppError(
          'agent_not_configured',
          'No model provider is configured, so the agent cannot answer.',
          503,
          { reason: state.reachable ? 'provider_not_configured' : 'provider_unreachable' },
        );
      }

      // Checked after the provider: questions that never reach a model must
      // not use up the operator's budget.
      limiter.check(operator.id);

      const startedAt = ctx.now();
      const runId = newId('run');
      insertRun.run(runId, operator.id, question, startedAt.toISOString());

      const sources = ctx.agentSources();
      const byToolName = new Map(sources.map((source) => [toolNameFor(source.id), source.id]));
      const tools: LlmToolDefinition[] = sources.map((source) => ({
        name: toolNameFor(source.id),
        description: source.description,
        parameters: source.args,
      }));

      const messages: LlmMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: question },
      ];

      const usedSourceIds = new Set<string>();
      let seq = 0;
      let sourceCalls = 0;
      let truncatedAny = false;
      let answer: string | null = null;
      let model: string | null = state.model;

      try {
        for (let round = 0; round < config.maxSteps; round += 1) {
          const remaining = config.budgetMs - (ctx.now().getTime() - startedAt.getTime());
          if (remaining <= 0) {
            throw new AppError(
              'agent_budget_exceeded',
              'The answer took too long. Please ask a narrower question.',
              504,
            );
          }

          const llmRequest: LlmRequest = {
            messages,
            tools,
            maxOutputTokens: 800,
          };
          const response = await provider.complete(
            llmRequest,
            Math.min(config.timeoutMs, remaining),
            loadSettings(),
          );
          model = response.model;

          if (response.toolCalls.length === 0) {
            answer = response.content.trim();
            break;
          }

          messages.push({
            role: 'assistant',
            content: response.content,
            toolCalls: response.toolCalls,
          });

          for (const call of response.toolCalls) {
            const sourceId = sourceIdFor(byToolName, call.name);
            seq += 1;

            if (sourceId === null) {
              messages.push({
                role: 'tool',
                toolCallId: call.id,
                content: JSON.stringify({ ok: false, error: 'unknown_source' }),
              });
              continue;
            }
            if (sourceCalls >= MAX_SOURCE_CALLS) {
              messages.push({
                role: 'tool',
                toolCallId: call.id,
                content: JSON.stringify({ ok: false, error: 'source_budget_exhausted' }),
              });
              continue;
            }
            sourceCalls += 1;

            // A source may not run after the overall budget is gone: the operator
            // asked for a prompt answer, not an exhausted connection.
            if (config.budgetMs - (ctx.now().getTime() - startedAt.getTime()) <= 0) {
              throw new AppError(
                'agent_budget_exceeded',
                'The answer took too long. Please ask a narrower question.',
                504,
              );
            }

            const source = sources.find((candidate) => candidate.id === sourceId);
            if (!source) {
              messages.push({
                role: 'tool',
                toolCallId: call.id,
                content: JSON.stringify({ ok: false, error: 'unknown_source' }),
              });
              continue;
            }

            let args: Record<string, unknown>;
            try {
              args = validateArguments(
                sourceId,
                source.args,
                JSON.parse(call.arguments) as unknown,
              );
            } catch (error) {
              const code =
                error instanceof ArgumentError ? 'invalid_arguments' : 'unreadable_arguments';
              insertStep.run(newId('stp'), runId, seq, sourceId, '{}', 'error', 0, null, 0, code);
              messages.push({
                role: 'tool',
                toolCallId: call.id,
                content: JSON.stringify({ ok: false, error: code }),
              });
              continue;
            }

            const callStarted = ctx.now().getTime();
            try {
              const result = await withTimeout(
                ctx.runAgentSource(sourceId, args),
                SOURCE_TIMEOUT_MS,
                'agent_source_timeout',
                'The data source did not answer in time.',
              );
              const durationMs = ctx.now().getTime() - callStarted;
              const serialized = JSON.stringify(result) ?? 'null';
              const bytes = Buffer.byteLength(serialized, 'utf8');
              const clipped = bytes > MAX_RESULT_BYTES;
              truncatedAny = truncatedAny || clipped;
              // A cut JSON document is not JSON. The model gets a valid
              // envelope with a preview instead of a broken fragment.
              const content = clipped
                ? JSON.stringify({
                    truncated: true,
                    bytes,
                    preview: serialized.slice(0, MAX_RESULT_BYTES - 100),
                  })
                : serialized;

              insertStep.run(
                newId('stp'),
                runId,
                seq,
                sourceId,
                JSON.stringify(args),
                'ok',
                durationMs,
                bytes,
                clipped ? 1 : 0,
                null,
              );
              usedSourceIds.add(sourceId);
              messages.push({ role: 'tool', toolCallId: call.id, content });
            } catch (error) {
              const durationMs = ctx.now().getTime() - callStarted;
              const code = error instanceof AppError ? error.code : 'agent_source_failed';
              // The code only: a source error message can name internal state.
              log.warn({ source: sourceId, code }, 'agent: source call failed');
              insertStep.run(
                newId('stp'),
                runId,
                seq,
                sourceId,
                JSON.stringify(args),
                'error',
                durationMs,
                null,
                0,
                code,
              );
              messages.push({
                role: 'tool',
                toolCallId: call.id,
                content: JSON.stringify({ ok: false, error: code }),
              });
            }
          }
        }

        if (answer === null || answer.length === 0) {
          throw new AppError(
            'agent_budget_exceeded',
            'The model did not reach an answer. Please ask a narrower question.',
            504,
          );
        }

        const finishedAt = ctx.now();
        finishRun.run(
          answer,
          'ok',
          null,
          model,
          finishedAt.getTime() - startedAt.getTime(),
          finishedAt.toISOString(),
          runId,
        );

        const row = db
          .prepare(
            `select id, question, answer, status, error_code, model, duration_ms, created_at,
             finished_at from agent_runs where id = ?`,
          )
          .get(runId) as RunRow;

        return {
          run: runToJson(row, stepsFor(runId)),
          sources: sourceInfos().filter((source) => usedSourceIds.has(source.id)),
          truncated: truncatedAny,
        };
      } catch (error) {
        const failure = error instanceof AppError ? error : null;
        const code = failure?.code ?? 'agent_failed';
        const finishedAt = ctx.now();
        finishRun.run(
          null,
          'error',
          code,
          model,
          finishedAt.getTime() - startedAt.getTime(),
          finishedAt.toISOString(),
          runId,
        );
        if (!failure) log.error({ err: error }, 'agent: unexpected failure');
        throw error;
      }
    },
  );

  app.get<{ Querystring: { limit?: string; cursor?: string; q?: string } }>(
    '/agent/runs',
    {
      preHandler: app.requireRole('operator'),
      schema: {
        summary: 'The caller’s own agent runs, newest first',
        tags: ['agent'],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'string' },
            cursor: { type: 'string' },
            q: { type: 'string', maxLength: 200 },
          },
        },
        response: { 200: listSchema, 400: errorSchema, 401: errorSchema, 403: errorSchema },
      },
    },
    async (request) => {
      const parsed = Number.parseInt(request.query.limit ?? '', 10);
      const limit = Number.isFinite(parsed) ? Math.min(50, Math.max(1, parsed)) : 20;

      let cursor = null;
      if (request.query.cursor) {
        cursor = decodeCursor(request.query.cursor);
        if (!cursor) throw new AppError('invalid_cursor', 'The cursor is invalid.', 400);
      }

      // A run holds the operator's own questions and answers, so the list is
      // always scoped to the caller: no operator reads another one's history.
      const operator = request.user;
      if (!operator) throw new AppError('unauthorized', 'Sign in required.', 401);

      const where: string[] = ['user_id = ?'];
      const params: unknown[] = [operator.id];
      const needle = (request.query.q ?? '').trim();
      if (needle.length > 0) {
        // `%`, `_` and `\` in the search text are literals, not wildcards.
        where.push("(lower(question) like ? escape '\\' or lower(coalesce(answer, '')) like ? escape '\\')");
        const pattern = `%${needle.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
        params.push(pattern, pattern);
      }
      const filters = where.join(' and ');

      const total = (
        db.prepare(`select count(*) as count from agent_runs where ${filters}`).get(...params) as {
          count: number;
        }
      ).count;

      const rows = (
        cursor
          ? db
              .prepare(
                `select id, question, answer, status, error_code, model, duration_ms, created_at,
                 finished_at from agent_runs
                 where ${filters} and (created_at < ? or (created_at = ? and id < ?))
                 order by created_at desc, id desc limit ?`,
              )
              .all(...params, cursor.created_at, cursor.created_at, cursor.id, limit + 1)
          : db
              .prepare(
                `select id, question, answer, status, error_code, model, duration_ms, created_at,
                 finished_at from agent_runs where ${filters}
                 order by created_at desc, id desc limit ?`,
              )
              .all(...params, limit + 1)
      ) as RunRow[];

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);

      return {
        items: ((steps) => page.map((row) => runToJson(row, steps.get(row.id) ?? [])))(
          stepsForRuns(page.map((row) => row.id)),
        ),
        total,
        nextCursor:
          hasMore && last ? encodeCursor({ created_at: last.created_at, id: last.id }) : null,
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/agent/runs/:id',
    {
      preHandler: app.requireRole('operator'),
      schema: {
        summary: 'One agent run with its source calls',
        tags: ['agent'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: runSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema },
      },
    },
    async (request) => {
      const operator = request.user;
      if (!operator) throw new AppError('unauthorized', 'Sign in required.', 401);
      const row = db
        .prepare(
          `select id, question, answer, status, error_code, model, duration_ms, created_at,
           finished_at from agent_runs where id = ? and user_id = ?`,
        )
        .get(request.params.id, operator.id) as RunRow | undefined;
      if (!row) throw new AppError('agent_run_not_found', 'Agent run not found.', 404);
      return runToJson(row, stepsFor(row.id));
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/agent/runs/:id',
    {
      preHandler: app.requireRole('operator'),
      schema: {
        summary: 'Delete one of the caller’s own agent runs',
        tags: ['agent'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 204: { type: 'null' }, 401: errorSchema, 403: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const operator = request.user;
      if (!operator) throw new AppError('unauthorized', 'Sign in required.', 401);
      // The steps cascade with the run (foreign_keys is on).
      const removed = db
        .prepare('delete from agent_runs where id = ? and user_id = ?')
        .run(request.params.id, operator.id);
      if (removed.changes === 0) {
        throw new AppError('agent_run_not_found', 'Agent run not found.', 404);
      }
      reply.code(204).send();
    },
  );

  app.delete(
    '/agent/runs',
    {
      preHandler: app.requireRole('operator'),
      schema: {
        summary: 'Delete every agent run of the caller',
        tags: ['agent'],
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['deleted'],
            properties: { deleted: { type: 'integer' } },
          },
          401: errorSchema,
          403: errorSchema,
        },
      },
    },
    async (request) => {
      const operator = request.user;
      if (!operator) throw new AppError('unauthorized', 'Sign in required.', 401);
      const removed = db
        .prepare('delete from agent_runs where user_id = ?')
        .run(operator.id);
      return { deleted: removed.changes };
    },
  );

  log.debug(`${manifest.id} plugin registered`);
}

export default { manifest, register };
