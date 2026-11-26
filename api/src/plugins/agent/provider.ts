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

/**
 * Calls the provider plugin through the internal route.
 *
 * The agent never holds a model key: the provider plugin owns the endpoint,
 * the credential and the retry policy. This adapter only knows the two paths
 * and the JSON shape from `shared/contract.ts`, so a different provider can
 * replace the plugin without touching the agent.
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

  return {
    async status(): Promise<ProviderState> {
      try {
        const response = await call('GET', '/status', undefined, config.timeoutMs);
        if (response.status !== 200) {
          return { configured: false, model: null, reachable: false };
        }
        const parsed = parseJson(response.body);
        if (!isRecord(parsed) || typeof parsed.configured !== 'boolean') {
          return { configured: false, model: null, reachable: false };
        }
        const model = typeof parsed.model === 'string' ? parsed.model : null;
        const status: LlmStatus = { configured: parsed.configured, model };
        return { ...status, reachable: true };
      } catch {
        // A provider that is down is not a configured provider. The page says
        // so instead of promising answers it cannot deliver.
        return { configured: false, model: null, reachable: false };
      }
    },

    async complete(request: LlmRequest, timeoutMs: number): Promise<LlmResponse> {
      const response = await call('POST', '/complete', request, timeoutMs);
      if (response.status !== 200) {
        throw new AppError(
          'agent_provider_failed',
          'The model provider rejected the request.',
          502,
          { reason: 'provider_rejected' },
        );
      }
      const parsed = parseJson(response.body);
      if (!isRecord(parsed)) {
        throw new AppError(
          'agent_provider_failed',
          'The model provider answered with an unreadable body.',
          502,
          { reason: 'invalid_provider_response' },
        );
      }

      const content = typeof parsed.content === 'string' ? parsed.content : '';
      const rawCalls = Array.isArray(parsed.toolCalls) ? parsed.toolCalls : [];
      const toolCalls: LlmToolCall[] = [];
      for (const raw of rawCalls) {
        if (!isRecord(raw)) {
          throw new AppError(
            'agent_provider_failed',
            'The model provider answered with an unreadable tool call.',
            502,
            { reason: 'invalid_provider_response' },
          );
        }
        const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : null;
        const name = typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : null;
        const args = typeof raw.arguments === 'string' ? raw.arguments : null;
        if (id === null || name === null || args === null) {
          throw new AppError(
            'agent_provider_failed',
            'The model provider answered with an unreadable tool call.',
            502,
            { reason: 'invalid_provider_response' },
          );
        }
        toolCalls.push({ id, name, arguments: args });
      }

      return {
        content,
        toolCalls,
        model:
          typeof parsed.model === 'string' && parsed.model.length > 0 ? parsed.model : 'unknown',
      };
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
