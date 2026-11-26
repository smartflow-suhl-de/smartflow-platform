/**
 * The wire contract between this plugin, its admin UI and the plugins that
 * call it. Nothing here reads a table or holds a secret: other plugins import
 * types only, never the server module.
 */

export type AuthStyle = 'bearer' | 'header' | 'none';
export type ProviderStatus = 'active' | 'disabled';
export type ModelStatus = 'active' | 'disabled';
export type ModelSource = 'manual' | 'discovered';

export interface Capabilities {
  tools: boolean;
  json: boolean;
  vision: boolean;
  embeddings: boolean;
}

export const EMPTY_CAPABILITIES: Capabilities = {
  tools: false,
  json: false,
  vision: false,
  embeddings: false,
};

/** A stored provider as the operator sees it. Never contains the key. */
export interface ProviderDto {
  id: string;
  name: string;
  preset: string;
  baseUrl: string;
  chatPath: string;
  apiVersion: string | null;
  authStyle: AuthStyle;
  authHeader: string | null;
  keySet: boolean;
  keyUpdatedAt: string | null;
  extraHeaderNames: string[];
  timeoutMs: number;
  maxRetries: number;
  rateLimitPerMinute: number;
  dailyTokenLimit: number;
  monthlyBudgetMicros: number;
  retentionDays: number;
  allowedPlugins: string[] | null;
  status: ProviderStatus;
  lastTestAt: string | null;
  lastTestStatus: string | null;
  lastTestMs: number | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  modelCount: number;
}

export interface ModelDto {
  id: string;
  providerId: string;
  modelKey: string;
  label: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  capabilities: Capabilities;
  inputCostMicrosPerMtok: number;
  outputCostMicrosPerMtok: number;
  isDefault: boolean;
  source: ModelSource;
  status: ModelStatus;
  createdAt: string;
}

/** The small model shape nested inside a purpose. */
export interface PurposeModelRef {
  id: string;
  modelKey: string;
  label: string;
  providerId: string;
  providerName: string;
  status: ModelStatus;
  capabilities: Capabilities;
}

export interface PurposeDto {
  purpose: string;
  description: string | null;
  model: PurposeModelRef | null;
  fallbackModel: PurposeModelRef | null;
  updatedAt: string;
  updatedBy: string;
  calls30d: number;
}

export interface UsageDto {
  id: string;
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
  createdAt: string;
}

export interface UsageSummaryDto {
  days: number;
  calls: number;
  ok: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  byCaller: Array<{ caller: string; calls: number; tokens: number; costMicros: number }>;
  byProvider: Array<{
    providerId: string | null;
    providerName: string | null;
    calls: number;
    costMicros: number;
  }>;
  byPurpose: Array<{ purpose: string; calls: number; costMicros: number }>;
}

export interface ProviderListResponse {
  items: ProviderDto[];
  total: number;
  nextCursor: string | null;
}

export interface UsageListResponse {
  items: UsageDto[];
  total: number;
  nextCursor: string | null;
}

export interface ModelListResponse {
  items: ModelDto[];
}

export interface PurposeListResponse {
  items: PurposeDto[];
}

export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number;
  code?: string;
  message?: string;
  models?: Array<{ modelKey: string; label?: string }>;
}

export interface ModelCandidate {
  modelKey: string;
  label?: string;
}

// --- Internal API -----------------------------------------------------------

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface InternalMessage {
  role: ChatRole;
  content: string;
  name?: string;
  tool_call_id?: string;
}

export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; name: string; schema: Record<string, unknown> };

export interface InternalCompleteRequest {
  purpose?: string;
  model?: string;
  messages: InternalMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: ResponseFormat;
  tools?: unknown[];
  toolChoice?: unknown;
  timeoutMs?: number;
  metadata?: { tenantId?: string; requestId?: string };
}

export interface InternalToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface InternalCompleteResponse {
  id: string;
  model: { modelKey: string; label: string; providerId: string; providerName: string };
  message: { role: 'assistant'; content: string; toolCalls: InternalToolCall[] };
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
  finishReason: string;
  latencyMs: number;
  costMicros: number;
}

export interface InternalEmbedResponse {
  id: string;
  model: { modelKey: string; label: string; providerId: string; providerName: string };
  vectors: number[][];
  usage: { inputTokens: number | null };
  latencyMs: number;
  costMicros: number;
}

export interface InternalStatusResponse {
  configured: boolean;
  providers: number;
  purposes: Array<{
    purpose: string;
    configured: boolean;
    model: {
      modelKey: string;
      label: string;
      providerId: string;
      providerName: string;
      capabilities: Capabilities;
    } | null;
  }>;
}
