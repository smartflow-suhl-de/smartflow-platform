import type {
  AuthStyle,
  Capabilities,
  ModelDto,
  ModelSource,
  ModelStatus,
  ProviderDto,
  ProviderStatus,
  PurposeDto,
  PurposeModelRef,
  UsageDto,
} from './protocol.ts';
import { EMPTY_CAPABILITIES } from './protocol.ts';

export interface ProviderRow {
  id: string;
  name: string;
  preset: string;
  base_url: string;
  chat_path: string;
  api_version: string | null;
  auth_style: AuthStyle;
  auth_header: string | null;
  api_key_sealed: string | null;
  api_key_updated_at: string | null;
  extra_headers_sealed: string | null;
  extra_header_names: string;
  timeout_ms: number;
  max_retries: number;
  rate_limit_per_minute: number;
  daily_token_limit: number;
  monthly_budget_micros: number;
  retention_days: number;
  allowed_plugins: string | null;
  status: ProviderStatus;
  is_default: number;
  last_test_at: string | null;
  last_test_status: string | null;
  last_test_ms: number | null;
  created_at: string;
  updated_at: string;
  created_by: string;
}

export interface ModelRow {
  id: string;
  provider_id: string;
  model_key: string;
  label: string;
  context_window: number | null;
  max_output_tokens: number | null;
  capabilities: string;
  input_cost_micros_per_mtok: number;
  output_cost_micros_per_mtok: number;
  is_default: number;
  source: ModelSource;
  status: ModelStatus;
  created_at: string;
}

export interface PurposeRow {
  purpose: string;
  model_id: string | null;
  fallback_model_id: string | null;
  description: string | null;
  updated_at: string;
  updated_by: string;
}

export interface UsageRow {
  id: string;
  provider_id: string | null;
  model_id: string | null;
  purpose: string;
  caller: string;
  tenant_id: string | null;
  status: 'ok' | 'error';
  error_code: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_micros: number;
  latency_ms: number | null;
  request_id: string | null;
  created_at: string;
}

export function parseCapabilities(raw: string | null | undefined): Capabilities {
  if (!raw) return { ...EMPTY_CAPABILITIES };
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return {
      tools: value.tools === true,
      json: value.json === true,
      vision: value.vision === true,
      embeddings: value.embeddings === true,
    };
  } catch {
    return { ...EMPTY_CAPABILITIES };
  }
}

export function parseAllowedPlugins(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return null;
    return value.filter((item): item is string => typeof item === 'string');
  } catch {
    return null;
  }
}

export function parseHeaderNames(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

export function toProvider(row: ProviderRow, modelCount: number): ProviderDto {
  return {
    id: row.id,
    name: row.name,
    preset: row.preset,
    baseUrl: row.base_url,
    chatPath: row.chat_path,
    apiVersion: row.api_version,
    authStyle: row.auth_style,
    authHeader: row.auth_header,
    keySet: row.api_key_sealed !== null,
    keyUpdatedAt: row.api_key_updated_at,
    extraHeaderNames: parseHeaderNames(row.extra_header_names),
    timeoutMs: row.timeout_ms,
    maxRetries: row.max_retries,
    rateLimitPerMinute: row.rate_limit_per_minute,
    dailyTokenLimit: row.daily_token_limit,
    monthlyBudgetMicros: row.monthly_budget_micros,
    retentionDays: row.retention_days,
    allowedPlugins: parseAllowedPlugins(row.allowed_plugins),
    status: row.status,
    isDefault: row.is_default === 1,
    lastTestAt: row.last_test_at,
    lastTestStatus: row.last_test_status,
    lastTestMs: row.last_test_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    modelCount,
  };
}

export function toModel(row: ModelRow): ModelDto {
  return {
    id: row.id,
    providerId: row.provider_id,
    modelKey: row.model_key,
    label: row.label,
    contextWindow: row.context_window,
    maxOutputTokens: row.max_output_tokens,
    capabilities: parseCapabilities(row.capabilities),
    inputCostMicrosPerMtok: row.input_cost_micros_per_mtok,
    outputCostMicrosPerMtok: row.output_cost_micros_per_mtok,
    isDefault: row.is_default === 1,
    source: row.source,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function toPurposeModelRef(model: ModelRow, provider: ProviderRow): PurposeModelRef {
  return {
    id: model.id,
    modelKey: model.model_key,
    label: model.label,
    providerId: provider.id,
    providerName: provider.name,
    status: model.status,
    capabilities: parseCapabilities(model.capabilities),
  };
}

export function toPurpose(
  row: PurposeRow,
  model: PurposeModelRef | null,
  fallbackModel: PurposeModelRef | null,
  calls30d: number,
): PurposeDto {
  return {
    purpose: row.purpose,
    description: row.description,
    model,
    fallbackModel,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    calls30d,
  };
}

export function toUsage(row: UsageRow): UsageDto {
  return {
    id: row.id,
    providerId: row.provider_id,
    modelId: row.model_id,
    purpose: row.purpose,
    caller: row.caller,
    tenantId: row.tenant_id,
    status: row.status,
    errorCode: row.error_code,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costMicros: row.cost_micros,
    latencyMs: row.latency_ms,
    requestId: row.request_id,
    createdAt: row.created_at,
  };
}

/** Joins the stored base URL with the configured chat path. */
export function chatEndpoint(provider: ProviderRow, modelKey: string): string {
  const base = provider.base_url.replace(/\/+$/, '');
  const path = provider.chat_path.replace('{model}', encodeURIComponent(modelKey));
  const url = new URL(`${base}${path.startsWith('/') ? path : `/${path}`}`);
  if (provider.api_version) url.searchParams.set('api-version', provider.api_version);
  return url.toString();
}

/** `/models` sits next to the chat path on every OpenAI-compatible gateway. */
export function listEndpoint(provider: ProviderRow): string {
  const url = new URL(`${provider.base_url.replace(/\/+$/, '')}/models`);
  if (provider.api_version) url.searchParams.set('api-version', provider.api_version);
  return url.toString();
}

export function embedEndpoint(provider: ProviderRow, modelKey: string): string {
  const base = provider.base_url.replace(/\/+$/, '');
  const path = provider.chat_path
    .replace('/chat/completions', '/embeddings')
    .replace('{model}', encodeURIComponent(modelKey));
  const url = new URL(`${base}${path.startsWith('/') ? path : `/${path}`}`);
  if (provider.api_version) url.searchParams.set('api-version', provider.api_version);
  return url.toString();
}

/** Costs are stored in millionths of a euro per million tokens. */
export function costMicros(
  inputTokens: number | null,
  outputTokens: number | null,
  inputCostMicrosPerMtok: number,
  outputCostMicrosPerMtok: number,
): number {
  const input = ((inputTokens ?? 0) * inputCostMicrosPerMtok) / 1_000_000;
  const output = ((outputTokens ?? 0) * outputCostMicrosPerMtok) / 1_000_000;
  return Math.round(input + output);
}

/** The provider's host, for a compact table cell without the key or query. */
export function providerHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
