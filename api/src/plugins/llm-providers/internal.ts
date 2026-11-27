import type { FastifyInstance, FastifyRequest } from 'fastify';
import { FieldError } from '../../shared/contract.ts';
import { AppError } from '../../kernel/errors.ts';
import {
  toPurposeModelRef,
  costMicros,
  type ModelRow,
  type ProviderRow,
  type PurposeRow,
} from './store.ts';
import type {
  Capabilities,
  InternalCompleteRequest,
  InternalCompleteResponse,
  InternalEmbedResponse,
  InternalStatusResponse,
  ResponseFormat,
} from './protocol.ts';
import { parseCapabilities } from './store.ts';
import type { LlmRuntime } from './runtime.ts';
import { UpstreamError, chatCompletion, embedTexts } from './upstream.ts';

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
        reason: { type: 'string' },
      },
    },
  },
} as const;

const objectSchema = { type: 'object', additionalProperties: true } as const;

const messageSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['role'],
  properties: {
    role: { type: 'string', enum: ['system', 'user', 'assistant', 'tool'] },
    // An assistant tool-call turn has content null or ""; the tool result
    // follows as its own message with tool_call_id.
    content: { type: ['string', 'null'], maxLength: 100_000 },
    name: { type: 'string', maxLength: 100 },
    tool_call_id: { type: 'string', maxLength: 200 },
    tool_calls: {
      type: 'array',
      maxItems: 32,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'function'],
        properties: {
          id: { type: 'string', maxLength: 200 },
          type: { type: 'string', enum: ['function'] },
          function: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'arguments'],
            properties: {
              name: { type: 'string', maxLength: 200 },
              arguments: { type: 'string', maxLength: 100_000 },
            },
          },
        },
      },
    },
  },
} as const;

const metadataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tenantId: { type: 'string', maxLength: 80 },
    requestId: { type: 'string', maxLength: 100 },
  },
} as const;

const responseFormatSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type'],
  properties: {
    type: { type: 'string', enum: ['text', 'json_object', 'json_schema'] },
    name: { type: 'string', maxLength: 100 },
    schema: { type: 'object', additionalProperties: true },
  },
} as const;

const completeBody = {
  type: 'object',
  additionalProperties: false,
  required: ['messages'],
  properties: {
    purpose: { type: 'string', minLength: 3, maxLength: 80 },
    model: { type: 'string', minLength: 1, maxLength: 200 },
    providerId: { type: 'string', minLength: 1, maxLength: 80 },
    modelId: { type: 'string', minLength: 1, maxLength: 80 },
    messages: { type: 'array', minItems: 1, maxItems: 50, items: messageSchema },
    temperature: { type: 'number', minimum: 0, maximum: 2 },
    maxTokens: { type: 'integer', minimum: 1, maximum: 8192 },
    responseFormat: responseFormatSchema,
    tools: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: true } },
    toolChoice: {
      anyOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }],
    },
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 60000 },
    metadata: metadataSchema,
  },
} as const;

const embedBody = {
  type: 'object',
  additionalProperties: false,
  required: ['input'],
  properties: {
    purpose: { type: 'string', minLength: 3, maxLength: 80 },
    model: { type: 'string', minLength: 1, maxLength: 200 },
    input: {
      type: 'array',
      minItems: 1,
      maxItems: 64,
      items: { type: 'string', minLength: 1, maxLength: 10_000 },
    },
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 60000 },
    metadata: metadataSchema,
  },
} as const;

interface Resolved {
  purpose: string;
  provider: ProviderRow;
  model: ModelRow;
  fallback: { provider: ProviderRow; model: ModelRow } | null;
}

interface AttemptResult {
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  provider: ProviderRow;
  model: ModelRow;
  latencyMs: number;
}

function requireCaller(request: FastifyRequest): string {
  const raw = request.headers['x-internal-caller'];
  const caller = typeof raw === 'string' ? raw.trim() : '';
  if (!caller) {
    throw new AppError('llm_caller_not_allowed', 'The internal caller is missing.', 403, {
      reason: 'caller_missing',
    });
  }
  return caller;
}

function responseFormat(body: InternalCompleteRequest): void {
  if (!body.responseFormat || body.responseFormat.type !== 'json_schema') return;
  if (!body.responseFormat.name || !body.responseFormat.schema) {
    throw new FieldError({
      responseFormat: 'json_schema needs a name and a schema.',
    });
  }
}

function assertCapabilities(
  model: ModelRow,
  body: { tools?: unknown[]; responseFormat?: ResponseFormat },
): Capabilities {
  const capabilities = parseCapabilities(model.capabilities);
  // OpenAI-compatible /v1/models discovery does not report capability flags,
  // so only enforce local capability blocks on manually configured models.
  if (model.source !== 'discovered') {
    if (body.tools && body.tools.length > 0 && !capabilities.tools) {
      throw new AppError(
        'llm_capability_unsupported',
        'This model does not support tool calling.',
        422,
        { reason: 'tools' },
      );
    }
    if (body.responseFormat && body.responseFormat.type !== 'text' && !capabilities.json) {
      throw new AppError(
        'llm_capability_unsupported',
        'This model does not support JSON output.',
        422,
        { reason: 'json' },
      );
    }
  }
  return capabilities;
}

function mapUpstream(error: UpstreamError): AppError {
  if (error.reason === 'timeout') {
    return new AppError('llm_provider_timeout', 'The provider did not answer in time.', 504, {
      reason: 'timeout',
    });
  }
  return new AppError('llm_provider_error', 'The provider rejected the request.', 502, {
    reason: error.reason,
  });
}

export function registerInternalRoutes(app: FastifyInstance, runtime: LlmRuntime): void {
  const internal = app.requireInternal;

  /** Sliding one-minute window; process-local by design and documented as such. */
  const windows = new Map<string, number[]>();
  function allowRate(key: string, limit: number): boolean {
    const now = runtime.now().getTime();
    const recent = (windows.get(key) ?? []).filter((stamp) => now - stamp < 60_000);
    if (recent.length >= limit) {
      windows.set(key, recent);
      return false;
    }
    recent.push(now);
    windows.set(key, recent);
    return true;
  }

  function resolveForCaller(
    caller: string,
    providerId?: string,
    modelId?: string,
  ): { provider: ProviderRow; model: ModelRow } | null {
    const activeProviders = runtime.db
      .prepare(
        "select * from llm_provider where status = 'active' order by is_default desc, created_at asc",
      )
      .all() as ProviderRow[];
    const allowed = activeProviders.filter((p) => runtime.isAllowedFor(p, caller));
    if (allowed.length === 0) return null;

    const pickModel = (provider: ProviderRow, preferredModelId?: string): ModelRow | undefined => {
      if (preferredModelId) {
        return runtime.db
          .prepare(
            "select * from llm_model where id = ? and provider_id = ? and status = 'active'",
          )
          .get(preferredModelId, provider.id) as ModelRow | undefined;
      }
      return runtime.db
        .prepare(
          `select * from llm_model
           where provider_id = ? and status = 'active'
           order by is_default desc, label asc limit 1`,
        )
        .get(provider.id) as ModelRow | undefined;
    };

    if (providerId) {
      const provider = allowed.find((p) => p.id === providerId);
      if (!provider) return null;
      const model = pickModel(provider, modelId);
      return model ? { provider, model } : null;
    }

    if (modelId) {
      for (const provider of allowed) {
        const model = pickModel(provider, modelId);
        if (model) return { provider, model };
      }
      return null;
    }

    for (const provider of allowed) {
      const model = pickModel(provider);
      if (model) return { provider, model };
    }
    return null;
  }

  function resolveTarget(
    purposeName: string,
    modelKey: string | undefined,
    caller?: string,
    providerId?: string,
    modelId?: string,
  ): Resolved {
    if ((providerId || modelId) && caller) {
      const direct = resolveForCaller(caller, providerId, modelId);
      if (!direct) {
        throw new AppError(
          'llm_provider_not_found',
          'No active allowed provider or model matches the selection.',
          409,
        );
      }
      return { purpose: purposeName, provider: direct.provider, model: direct.model, fallback: null };
    }

    if (modelKey) {
      const model = runtime.db
        .prepare(
          `select m.* from llm_model m
           join llm_provider p on p.id = m.provider_id
           where m.model_key = ? and m.status = 'active' and p.status = 'active'
           order by m.is_default desc limit 1`,
        )
        .get(modelKey) as ModelRow | undefined;
      if (!model) {
        throw new AppError('llm_model_not_found', 'Model not found or disabled.', 404);
      }
      const provider = runtime.provider(model.provider_id);
      if (!provider) throw new AppError('llm_provider_not_found', 'Provider not found.', 404);
      return { purpose: purposeName, provider, model, fallback: null };
    }

    const purpose = runtime.purpose(purposeName);
    if (!purpose || !purpose.model_id) {
      if (caller) {
        const fallbackDirect = resolveForCaller(caller);
        if (fallbackDirect) {
          return {
            purpose: purposeName,
            provider: fallbackDirect.provider,
            model: fallbackDirect.model,
            fallback: null,
          };
        }
      }
      throw new AppError('llm_purpose_unmapped', 'No model is assigned to this purpose.', 409);
    }
    const model = runtime.model(purpose.model_id);
    if (!model) {
      throw new AppError('llm_purpose_unmapped', 'No model is assigned to this purpose.', 409);
    }
    const provider = runtime.provider(model.provider_id);
    if (!provider || provider.status !== 'active' || model.status !== 'active') {
      throw new AppError('llm_provider_disabled', 'The model or its provider is disabled.', 409);
    }
    let fallback: Resolved['fallback'] = null;
    if (purpose.fallback_model_id) {
      const fallbackModel = runtime.model(purpose.fallback_model_id);
      const fallbackProvider = fallbackModel ? runtime.provider(fallbackModel.provider_id) : null;
      if (
        fallbackModel &&
        fallbackProvider &&
        fallbackModel.status === 'active' &&
        fallbackProvider.status === 'active'
      ) {
        fallback = { provider: fallbackProvider, model: fallbackModel };
      }
    }
    return { purpose: purposeName, provider, model, fallback };
  }

  function currentPurposeName(body: { purpose?: string; model?: string }): string {
    if (body.purpose) return body.purpose.trim();
    if (body.model) return `model.${body.model}`;
    return 'unknown';
  }

  async function complete(
    request: FastifyRequest,
    target: Resolved,
    body: InternalCompleteRequest,
  ): Promise<AttemptResult> {
    const primary = { provider: target.provider, model: target.model };
    const attempts: Array<{ provider: ProviderRow; model: ModelRow }> = [primary];
    if (target.fallback) {
      attempts.push(target.fallback);
    } else if (target.provider.max_retries > 0) {
      // Without a fallback, the configured retry is one more try on the same
      // model. The second entry is deliberate, not a duplicate by accident.
      attempts.push(primary);
    }

    const caller = requireCaller(request);
    let lastError: UpstreamError | null = null;
    let lastLimit: AppError | null = null;
    for (const [index, attempt] of attempts.entries()) {
      if (!runtime.isAllowedFor(attempt.provider, caller)) continue;
      if (!allowRate(`${caller}:${attempt.provider.id}`, attempt.provider.rate_limit_per_minute)) {
        const error = new AppError('llm_rate_limited', 'Too many calls for this plugin.', 429);
        // A configured fallback runs on another provider with its own quota.
        if (index === 0 && !target.fallback) throw error;
        lastLimit = error;
        continue;
      }
      const budget = runtime.budgetExceeded(attempt.provider);
      if (budget) {
        const error = new AppError(
          'llm_budget_exceeded',
          budget === 'daily'
            ? 'The daily token budget of this provider is exhausted.'
            : 'The monthly budget of this provider is exhausted.',
          429,
          { reason: budget },
        );
        // The fallback provider has a separate budget.
        if (index === 0 && !target.fallback) throw error;
        lastLimit = error;
        continue;
      }
      try {
        assertCapabilities(attempt.model, body);
      } catch (error) {
        if (index > 0) continue;
        throw error;
      }
      const key = runtime.openKey(attempt.provider);
      const headers = runtime.openHeaders(attempt.provider);
      const timeout = Math.min(
        body.timeoutMs ?? attempt.provider.timeout_ms,
        runtime.maxTimeoutMs,
        attempt.provider.timeout_ms,
      );
      const limit = attempt.model.max_output_tokens;
      const attemptStarted = Date.now();
      try {
        const result = await chatCompletion(
          attempt.provider,
          attempt.model,
          {
            messages: body.messages,
            ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
            ...(body.maxTokens === undefined
              ? {}
              : { maxTokens: limit ? Math.min(body.maxTokens, limit) : body.maxTokens }),
            ...(body.responseFormat === undefined ? {} : { responseFormat: body.responseFormat }),
            ...(body.tools === undefined ? {} : { tools: body.tools }),
            ...(body.toolChoice === undefined ? {} : { toolChoice: body.toolChoice }),
          },
          key,
          headers,
          timeout,
        );
        return {
          ...result,
          provider: attempt.provider,
          model: attempt.model,
          latencyMs: Date.now() - attemptStarted,
        };
      } catch (error) {
        if (!(error instanceof UpstreamError)) throw error;
        lastError = error;
        if (!error.retryable) throw mapUpstream(error);
        // A configured fallback is the first retry. Without one, a provider
        // with max_retries gets exactly one more chance on the same model.
        if (index === 0 && !target.fallback && attempt.provider.max_retries > 0) {
          continue;
        }
        if (index === attempts.length - 1) throw mapUpstream(error);
      }
    }
    if (lastError) throw mapUpstream(lastError);
    if (lastLimit) throw lastLimit;
    throw new AppError('llm_not_configured', 'No provider is available.', 503);
  }

  function usageError(
    error: unknown,
    caller: string,
    purpose: string,
    target: Resolved | null,
    body: { metadata?: { tenantId?: string; requestId?: string } },
    started: number,
    action: 'llm.complete' | 'llm.embed' = 'llm.complete',
  ): void {
    const code =
      error instanceof AppError
        ? error.code
        : error instanceof FieldError
          ? 'validation_failed'
          : 'llm_provider_error';
    const latencyMs = Date.now() - started;
    runtime.recordUsage({
      providerId: target?.provider.id ?? null,
      modelId: target?.model.id ?? null,
      purpose,
      caller,
      tenantId: body.metadata?.tenantId ?? null,
      status: 'error',
      errorCode: code,
      inputTokens: null,
      outputTokens: null,
      costMicros: 0,
      latencyMs,
      requestId: body.metadata?.requestId ?? null,
    });
    const detail =
      error instanceof AppError
        ? error.message
        : error instanceof FieldError
          ? Object.values(error.fields).join('; ')
          : error instanceof Error
            ? error.message
            : 'Unbekannter Fehler';
    const modelLabel = target?.model.model_key ?? purpose;
    runtime.recordLog(
      'error',
      action,
      `[${caller}] ${modelLabel} fehlgeschlagen (${code}, ${latencyMs} ms): ${detail}`,
      target ? { id: target.provider.id, name: target.provider.name } : undefined,
    );
  }

  app.post<{ Body: InternalCompleteRequest }>(
    '/llm/internal/complete',
    {
      preHandler: internal,
      schema: {
        summary: 'Run a chat completion for another plugin',
        tags: ['llm-providers'],
        body: completeBody,
        response: {
          200: objectSchema,
          401: errorSchema,
          403: errorSchema,
          409: errorSchema,
          422: errorSchema,
          429: errorSchema,
          502: errorSchema,
          503: errorSchema,
          504: errorSchema,
        },
      },
    },
    async (request) => {
      const started = Date.now();
      const caller = requireCaller(request);
      const body = request.body;
      const purpose = currentPurposeName(body);
      let target: Resolved | null = null;

      try {
        const bodyWithTarget = body as InternalCompleteRequest & {
          providerId?: string;
          modelId?: string;
        };
        if (!body.purpose && !body.model && !bodyWithTarget.providerId && !bodyWithTarget.modelId) {
          throw new FieldError({ purpose: 'Send a purpose or a model.' });
        }
        responseFormat(body);
        target = resolveTarget(
          purpose,
          body.model,
          caller,
          bodyWithTarget.providerId,
          bodyWithTarget.modelId,
        );
        if (!runtime.isAllowedFor(target.provider, caller)) {
          throw new AppError(
            'llm_caller_not_allowed',
            'This plugin may not use the provider.',
            403,
          );
        }
        const result = await complete(request, target, body);
        const cost = costMicros(
          result.inputTokens,
          result.outputTokens,
          result.model.input_cost_micros_per_mtok,
          result.model.output_cost_micros_per_mtok,
        );
        const latencyMs = Date.now() - started;
        const id = runtime.recordUsage({
          providerId: result.provider.id,
          modelId: result.model.id,
          purpose: target.purpose,
          caller,
          tenantId: body.metadata?.tenantId ?? null,
          status: 'ok',
          errorCode: null,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costMicros: cost,
          latencyMs,
          requestId: body.metadata?.requestId ?? null,
        });
        runtime.recordLog(
          'info',
          'llm.complete',
          `[${caller}] ${result.model.model_key} erfolgreich (${latencyMs} ms, ${result.inputTokens ?? 0}/${result.outputTokens ?? 0} Tokens).`,
          { id: result.provider.id, name: result.provider.name },
        );
        const response: InternalCompleteResponse = {
          id,
          model: {
            modelKey: result.model.model_key,
            label: result.model.label,
            providerId: result.provider.id,
            providerName: result.provider.name,
          },
          message: {
            role: 'assistant',
            content: result.content,
            toolCalls: result.toolCalls,
          },
          usage: {
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            totalTokens:
              result.totalTokens ??
              (result.inputTokens !== null && result.outputTokens !== null
                ? result.inputTokens + result.outputTokens
                : null),
          },
          finishReason: result.finishReason,
          latencyMs: Date.now() - started,
          costMicros: cost,
        };
        return response;
      } catch (error) {
        // Map upstream failures before they reach Fastify: its 500 handler logs
        // the error object, and an unmapped UpstreamError carries the raw
        // provider detail. The mapped AppError has a stable code and no body.
        const mapped = error instanceof UpstreamError ? mapUpstream(error) : error;
        usageError(mapped, caller, purpose, target, body, started, 'llm.complete');
        throw mapped;
      }
    },
  );

  app.post<{
    Body: {
      purpose?: string;
      model?: string;
      input: string[];
      timeoutMs?: number;
      metadata?: { tenantId?: string; requestId?: string };
    };
  }>(
    '/llm/internal/embed',
    {
      preHandler: internal,
      schema: {
        summary: 'Embed texts for another plugin',
        tags: ['llm-providers'],
        body: embedBody,
        response: {
          200: objectSchema,
          401: errorSchema,
          403: errorSchema,
          409: errorSchema,
          422: errorSchema,
          429: errorSchema,
          502: errorSchema,
          503: errorSchema,
          504: errorSchema,
        },
      },
    },
    async (request) => {
      const started = Date.now();
      const caller = requireCaller(request);
      const body = request.body;
      const purpose = currentPurposeName(body);
      let target: Resolved | null = null;

      try {
        if (!body.purpose && !body.model) {
          throw new FieldError({ purpose: 'Send a purpose or a model.' });
        }
        target = resolveTarget(purpose, body.model);
        if (!runtime.isAllowedFor(target.provider, caller)) {
          throw new AppError(
            'llm_caller_not_allowed',
            'This plugin may not use the provider.',
            403,
          );
        }
        const capabilities = parseCapabilities(target.model.capabilities);
        if (!capabilities.embeddings) {
          throw new AppError(
            'llm_capability_unsupported',
            'This model does not support embeddings.',
            422,
            { reason: 'embeddings' },
          );
        }
        if (!allowRate(`${caller}:${target.provider.id}`, target.provider.rate_limit_per_minute)) {
          throw new AppError('llm_rate_limited', 'Too many calls for this plugin.', 429);
        }
        const budget = runtime.budgetExceeded(target.provider);
        if (budget) {
          throw new AppError('llm_budget_exceeded', 'The provider budget is exhausted.', 429, {
            reason: budget,
          });
        }

        const key = runtime.openKey(target.provider);
        const headers = runtime.openHeaders(target.provider);
        const timeout = Math.min(
          body.timeoutMs ?? target.provider.timeout_ms,
          runtime.maxTimeoutMs,
          target.provider.timeout_ms,
        );
        const result = await embedTexts(
          target.provider,
          target.model,
          body.input,
          key,
          headers,
          timeout,
        );
        const cost = costMicros(
          result.inputTokens,
          null,
          target.model.input_cost_micros_per_mtok,
          target.model.output_cost_micros_per_mtok,
        );
        const latencyMs = Date.now() - started;
        const id = runtime.recordUsage({
          providerId: target.provider.id,
          modelId: target.model.id,
          purpose: target.purpose,
          caller,
          tenantId: body.metadata?.tenantId ?? null,
          status: 'ok',
          errorCode: null,
          inputTokens: result.inputTokens,
          outputTokens: null,
          costMicros: cost,
          latencyMs,
          requestId: body.metadata?.requestId ?? null,
        });
        runtime.recordLog(
          'info',
          'llm.embed',
          `[${caller}] ${target.model.model_key} Embeddings erfolgreich (${latencyMs} ms, ${result.inputTokens ?? 0} Tokens).`,
          { id: target.provider.id, name: target.provider.name },
        );
        const response: InternalEmbedResponse = {
          id,
          model: {
            modelKey: target.model.model_key,
            label: target.model.label,
            providerId: target.provider.id,
            providerName: target.provider.name,
          },
          vectors: result.vectors,
          usage: { inputTokens: result.inputTokens },
          latencyMs: Date.now() - started,
          costMicros: cost,
        };
        return response;
      } catch (error) {
        // Map upstream failures before they reach Fastify: its 500 handler logs
        // the error object, and an unmapped UpstreamError carries the raw
        // provider detail. The mapped AppError has a stable code and no body.
        const mapped = error instanceof UpstreamError ? mapUpstream(error) : error;
        usageError(mapped, caller, purpose, target, body, started, 'llm.embed');
        throw mapped;
      }
    },
  );

  function purposeState(purpose: PurposeRow): {
    model: ModelRow | undefined;
    provider: ProviderRow | undefined;
    configured: boolean;
  } {
    const model = purpose.model_id ? runtime.model(purpose.model_id) : undefined;
    const provider = model ? runtime.provider(model.provider_id) : undefined;
    return {
      model,
      provider,
      // Single source of truth for /status and /models: a purpose counts as
      // configured only when both the model and its provider are active.
      configured: Boolean(
        model && provider && model.status === 'active' && provider.status === 'active',
      ),
    };
  }

  app.get<{ Querystring: { providerId?: string; modelId?: string } }>(
    '/llm/internal/status',
    {
      preHandler: internal,
      schema: {
        summary: 'Report configured purposes and caller availability without secrets',
        tags: ['llm-providers'],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            providerId: { type: 'string', maxLength: 80 },
            modelId: { type: 'string', maxLength: 80 },
          },
        },
        response: { 200: objectSchema, 401: errorSchema },
      },
    },
    async (request) => {
      const purposes = runtime.db
        .prepare('select * from llm_purpose order by purpose')
        .all() as PurposeRow[];
      const items = purposes.map((purpose) => {
        const state = purposeState(purpose);
        const response: InternalStatusResponse['purposes'][number] = {
          purpose: purpose.purpose,
          configured: state.configured,
          model:
            state.configured && state.model && state.provider
              ? {
                  modelKey: state.model.model_key,
                  label: state.model.label,
                  providerId: state.provider.id,
                  providerName: state.provider.name,
                  capabilities: parseCapabilities(state.model.capabilities),
                }
              : null,
        };
        return response;
      });
      const providers = (
        runtime.db
          .prepare("select count(*) as count from llm_provider where status = 'active'")
          .get() as { count: number }
      ).count;
      const rawCaller = request.headers['x-internal-caller'];
      const caller = typeof rawCaller === 'string' ? rawCaller.trim() : '';
      const direct = caller
        ? resolveForCaller(caller, request.query.providerId, request.query.modelId)
        : null;
      return {
        configured: items.some((item) => item.configured) || direct !== null,
        providers,
        purposes: items,
        availableForCaller: direct
          ? {
              configured: true,
              providerId: direct.provider.id,
              providerName: direct.provider.name,
              modelId: direct.model.id,
              modelKey: direct.model.model_key,
            }
          : {
              configured: false,
              providerId: null,
              providerName: null,
              modelId: null,
              modelKey: null,
            },
      };
    },
  );

  app.get<{ Querystring: { purpose?: string } }>(
    '/llm/internal/models',
    {
      preHandler: internal,
      schema: {
        summary: 'Report the model behind a purpose',
        tags: ['llm-providers'],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { purpose: { type: 'string', maxLength: 80 } },
        },
        response: { 200: objectSchema, 401: errorSchema, 404: errorSchema },
      },
    },
    async (request) => {
      if (request.query.purpose) {
        const target = resolveTarget(request.query.purpose, undefined);
        const purpose = runtime.purpose(target.purpose) as PurposeRow;
        const state = purposeState(purpose);
        return {
          purpose: target.purpose,
          configured: state.configured,
          model: state.configured
            ? {
                ...toPurposeModelRef(target.model, target.provider),
                fallback:
                  purpose.fallback_model_id && target.fallback
                    ? toPurposeModelRef(target.fallback.model, target.fallback.provider)
                    : null,
              }
            : null,
        };
      }
      const statuses = runtime.db
        .prepare('select * from llm_purpose order by purpose')
        .all() as PurposeRow[];
      return {
        items: statuses.map((purpose) => {
          const state = purposeState(purpose);
          return {
            purpose: purpose.purpose,
            configured: state.configured,
            model:
              state.configured && state.model && state.provider
                ? toPurposeModelRef(state.model, state.provider)
                : null,
          };
        }),
      };
    },
  );
}
