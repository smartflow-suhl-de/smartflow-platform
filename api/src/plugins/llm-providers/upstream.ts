import type { InternalMessage, InternalToolCall, ResponseFormat } from './protocol.ts';
import { assertResolvedTarget, isBlockedExtraHeader, loopbackAllowed } from './ssrf.ts';
import {
  chatEndpoint,
  embedEndpoint,
  listEndpoint,
  type ModelRow,
  type ProviderRow,
} from './store.ts';

export type UpstreamReason =
  'auth' | 'rate_limit' | 'http' | 'invalid_response' | 'timeout' | 'network';

export class UpstreamError extends Error {
  readonly reason: UpstreamReason;
  readonly status: number;
  readonly retryable: boolean;
  readonly detail: string | null;

  constructor(reason: UpstreamReason, message: string, retryable: boolean, detail?: string) {
    super(message);
    this.name = 'UpstreamError';
    this.reason = reason;
    this.status = reason === 'auth' ? 401 : reason === 'rate_limit' ? 429 : 502;
    this.retryable = retryable;
    this.detail = detail ?? null;
  }
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface ChatResult {
  content: string;
  toolCalls: InternalToolCall[];
  finishReason: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface EmbedResult {
  vectors: number[][];
  inputTokens: number | null;
}

function buildHeaders(
  provider: ProviderRow,
  apiKey: string | null,
  extraHeaders: Record<string, string>,
): Record<string, string> {
  const authName = (provider.auth_header ?? 'Authorization').toLowerCase();
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  for (const [name, value] of Object.entries(extraHeaders)) {
    // A stored extra header must never shadow the secret or a managed header.
    if (isBlockedExtraHeader(name) || name.toLowerCase() === authName) continue;
    headers[name] = value;
  }
  if (provider.auth_style === 'bearer' && apiKey) {
    headers[provider.auth_header ?? 'Authorization'] = `Bearer ${apiKey}`;
  } else if (provider.auth_style === 'header' && apiKey) {
    headers[provider.auth_header ?? 'x-api-key'] = apiKey;
  }
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Streams the body and stops at the cap, so a provider cannot make the process
 * buffer an unbounded answer before the length is known.
 */
async function readBody(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new UpstreamError(
          'invalid_response',
          'The provider response is too large.',
          false,
          'response over 4 MiB',
        );
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock();
  }
}

async function request(
  provider: ProviderRow,
  url: string,
  apiKey: string | null,
  extraHeaders: Record<string, string>,
  init: { method: 'GET' | 'POST'; body?: unknown },
  timeoutMs: number,
): Promise<unknown> {
  try {
    await assertResolvedTarget(new URL(url), loopbackAllowed());
  } catch {
    throw new UpstreamError('network', 'The provider target is not allowed.', false);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: buildHeaders(provider, apiKey, extraHeaders),
      redirect: 'error',
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new UpstreamError('timeout', 'The provider did not answer in time.', true);
    }
    throw new UpstreamError('network', 'The provider could not be reached.', true);
  }

  let text: string;
  try {
    text = await readBody(response);
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError('network', 'The provider response could not be read.', true);
  }

  if (!response.ok) {
    const detail = text.slice(0, 300);
    if (response.status === 401 || response.status === 403) {
      throw new UpstreamError('auth', 'The provider rejected the credentials.', false, detail);
    }
    if (response.status === 429) {
      throw new UpstreamError('rate_limit', 'The provider is rate limiting.', true, detail);
    }
    throw new UpstreamError(
      'http',
      `The provider answered with HTTP ${response.status}.`,
      response.status >= 500,
      detail,
    );
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UpstreamError('invalid_response', 'The provider did not answer with JSON.', false);
  }
}

function messageContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => {
      if (typeof part === 'string') return part;
      if (isRecord(part) && typeof part.text === 'string') return part.text;
      return '';
    })
    .join('');
}

function parseToolCalls(value: unknown): InternalToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: InternalToolCall[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const fn = entry.function;
    if (!isRecord(fn) || typeof fn.name !== 'string') continue;
    calls.push({
      id: typeof entry.id === 'string' ? entry.id : `call_${calls.length}`,
      name: fn.name,
      arguments: typeof fn.arguments === 'string' ? fn.arguments : '{}',
    });
  }
  return calls;
}

function responseFormat(format: ResponseFormat | undefined): unknown {
  if (!format || format.type === 'text') return undefined;
  if (format.type === 'json_object') return { type: 'json_object' };
  return {
    type: 'json_schema',
    json_schema: { name: format.name, schema: format.schema },
  };
}

export async function chatCompletion(
  provider: ProviderRow,
  model: ModelRow,
  requestBody: {
    messages: InternalMessage[];
    temperature?: number;
    maxTokens?: number;
    responseFormat?: ResponseFormat;
    tools?: unknown[];
    toolChoice?: unknown;
  },
  apiKey: string | null,
  extraHeaders: Record<string, string>,
  timeoutMs: number,
): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: model.model_key,
    messages: requestBody.messages,
  };
  if (requestBody.temperature !== undefined) body.temperature = requestBody.temperature;
  if (requestBody.maxTokens !== undefined) body.max_tokens = requestBody.maxTokens;
  const format = responseFormat(requestBody.responseFormat);
  if (format !== undefined) body.response_format = format;
  if (requestBody.tools && requestBody.tools.length > 0) body.tools = requestBody.tools;
  if (requestBody.toolChoice !== undefined) body.tool_choice = requestBody.toolChoice;

  const payload = await request(
    provider,
    chatEndpoint(provider, model.model_key),
    apiKey,
    extraHeaders,
    { method: 'POST', body },
    timeoutMs,
  );
  if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
    throw new UpstreamError('invalid_response', 'The provider response has no choices.', false);
  }
  const choice = payload.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw new UpstreamError('invalid_response', 'The provider response has no message.', false);
  }
  const usage = isRecord(payload.usage) ? payload.usage : {};

  return {
    content: messageContent(choice.message.content),
    toolCalls: parseToolCalls(choice.message.tool_calls),
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop',
    inputTokens: asNumber(usage.prompt_tokens),
    outputTokens: asNumber(usage.completion_tokens),
    totalTokens: asNumber(usage.total_tokens),
  };
}

export async function listModels(
  provider: ProviderRow,
  apiKey: string | null,
  extraHeaders: Record<string, string>,
  timeoutMs = 5000,
): Promise<Array<{ modelKey: string; label?: string }>> {
  const payload = await request(
    provider,
    listEndpoint(provider),
    apiKey,
    extraHeaders,
    { method: 'GET' },
    timeoutMs,
  );
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new UpstreamError('invalid_response', 'The provider did not return a model list.', false);
  }
  const models: Array<{ modelKey: string; label?: string }> = [];
  for (const entry of payload.data) {
    if (!isRecord(entry) || typeof entry.id !== 'string') continue;
    models.push({ modelKey: entry.id });
  }
  return models;
}

export async function embedTexts(
  provider: ProviderRow,
  model: ModelRow,
  input: string[],
  apiKey: string | null,
  extraHeaders: Record<string, string>,
  timeoutMs: number,
): Promise<EmbedResult> {
  const payload = await request(
    provider,
    embedEndpoint(provider, model.model_key),
    apiKey,
    extraHeaders,
    { method: 'POST', body: { model: model.model_key, input } },
    timeoutMs,
  );
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new UpstreamError('invalid_response', 'The provider returned no embeddings.', false);
  }
  const vectors: number[][] = [];
  for (const entry of payload.data) {
    if (!isRecord(entry) || !Array.isArray(entry.embedding)) continue;
    const vector = entry.embedding.filter(
      (item): item is number => typeof item === 'number' && Number.isFinite(item),
    );
    vectors.push(vector);
  }
  if (vectors.length === 0) {
    throw new UpstreamError('invalid_response', 'The provider returned no embeddings.', false);
  }
  const usage = isRecord(payload.usage) ? payload.usage : {};
  return { vectors, inputTokens: asNumber(usage.prompt_tokens) };
}
