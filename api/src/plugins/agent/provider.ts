import type { LlmRequest, LlmResponse, LlmStatus, LlmToolCall } from '../../shared/contract.ts';
import type { PluginContext } from '../../kernel/context.ts';
import { AppError } from '../../kernel/errors.ts';
import type { AgentConfig } from '../../kernel/config.ts';

/** Status as the page needs it: configured, model, and whether the plugin answered. */
export interface ProviderState {
  configured: boolean;
  model: string | null;
  reachable: boolean;
}

export interface LlmProvider {
  status(): Promise<ProviderState>;
  complete(request: LlmRequest, timeoutMs: number): Promise<LlmResponse>;
}

/** The purpose the operator maps to a model in the provider plugin. */
export const AGENT_PURPOSE = 'agent';

/** Neutral agent request -> wire form of `POST {base}/internal/complete`. */
export function toWireRequest(request: LlmRequest, timeoutMs: number): Record<string, unknown> {
  return {
    purpose: AGENT_PURPOSE,
    messages: request.messages.map((message) => {
      if (message.role === 'tool') {
        return { role: 'tool', content: message.content, tool_call_id: message.toolCallId };
      }
      if (message.role === 'assistant') {
        return {
          role: 'assistant',
          content: message.content,
          ...(message.toolCalls && message.toolCalls.length > 0
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        };
      }
      return { role: message.role, content: message.content };
    }),
    ...(request.tools && request.tools.length > 0
      ? {
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        }
      : {}),
    ...(request.maxOutputTokens === undefined ? {} : { maxTokens: request.maxOutputTokens }),
    // The route accepts 1 s to 60 s; the agent's own timeout still wins above.
    timeoutMs: Math.min(60_000, Math.max(1_000, Math.floor(timeoutMs))),
  };
}

/**
 * Calls the provider plugin through its internal route
 * (`{base}/internal/status`, `{base}/internal/complete`).
 *
 * The agent never holds a model key: the provider plugin owns the endpoint,
 * the credential and the retry policy. This adapter maps the agent's neutral
 * shape (`shared/contract.ts`) to that route and back, so the provider's wire
 * format stays out of the agent loop.
 */
export function createProvider(ctx: PluginContext, config: AgentConfig): LlmProvider {
  const base = config.providerBase;

  async function call(
    method: 'GET' | 'POST',
    path: string,
    payload: unknown,
    timeoutMs: number,
  ): Promise<{ status: number; body: string }> {
    return await withTimeout(
      ctx.callInternal('agent', { method, url: `${base}${path}`, payload }),
      timeoutMs,
      'agent_provider_timeout',
      'The model did not answer in time.',
    );
  }

  const unreadable = (what: string): AppError =>
    new AppError('agent_provider_failed', `The model provider answered with ${what}.`, 502, {
      reason: 'invalid_provider_response',
    });

  return {
    async status(): Promise<ProviderState> {
      try {
        const response = await call('GET', '/internal/status', undefined, config.timeoutMs);
        if (response.status !== 200) {
          return { configured: false, model: null, reachable: false };
        }
        const parsed = parseJson(response.body);
        if (!isRecord(parsed) || !Array.isArray(parsed.purposes)) {
          return { configured: false, model: null, reachable: false };
        }
        // Configured means: the `agent` purpose has a model, not "some purpose does".
        const entry = parsed.purposes.find(
          (item): item is Record<string, unknown> =>
            isRecord(item) && item.purpose === AGENT_PURPOSE,
        );
        const model = entry && isRecord(entry.model) ? entry.model : null;
        const configured = entry?.configured === true && model !== null;
        const label =
          model && typeof model.modelKey === 'string' && model.modelKey.length > 0
            ? model.modelKey
            : null;
        const status: LlmStatus = { configured, model: configured ? label : null };
        return { ...status, reachable: true };
      } catch {
        // A provider that is down is not a configured provider. The page says
        // so instead of promising answers it cannot deliver.
        return { configured: false, model: null, reachable: false };
      }
    },

    async complete(request: LlmRequest, timeoutMs: number): Promise<LlmResponse> {
      const response = await call(
        'POST',
        '/internal/complete',
        toWireRequest(request, timeoutMs),
        timeoutMs,
      );
      if (response.status !== 200) {
        throw new AppError(
          'agent_provider_failed',
          'The model provider rejected the request.',
          502,
          { reason: 'provider_rejected' },
        );
      }
      const parsed = parseJson(response.body);
      if (!isRecord(parsed) || !isRecord(parsed.message)) throw unreadable('an unreadable body');

      const message = parsed.message;
      const content = typeof message.content === 'string' ? message.content : '';
      const rawCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
      const toolCalls: LlmToolCall[] = [];
      for (const raw of rawCalls) {
        if (!isRecord(raw)) throw unreadable('an unreadable tool call');
        const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : null;
        const name = typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : null;
        const args = typeof raw.arguments === 'string' ? raw.arguments : null;
        if (id === null || name === null || args === null) {
          throw unreadable('an unreadable tool call');
        }
        toolCalls.push({ id, name, arguments: args });
      }

      const modelInfo = isRecord(parsed.model) ? parsed.model : null;
      const model =
        modelInfo && typeof modelInfo.modelKey === 'string' && modelInfo.modelKey.length > 0
          ? modelInfo.modelKey
          : 'unknown';
      return { content, toolCalls, model };
    },
  };
}

export function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  code: string,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AppError(code, message, 504));
    }, ms);
    // Attaching both handlers also keeps a late rejection from becoming an
    // unhandled one after the race has already been lost.
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
