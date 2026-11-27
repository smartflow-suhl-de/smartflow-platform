/**
 * Shared contract between kernel, plugins and web.
 * Pure types and small helpers only — no runtime dependencies.
 */

export const KERNEL_API_VERSION = 1;

export type Role = 'operator' | 'tenant_admin' | 'employee';

export const ROLES: readonly Role[] = ['operator', 'tenant_admin', 'employee'];

export interface PluginNav {
  label: string;
  path: string;
  group: 'work' | 'management';
  icon: string;
  order?: number;
  roles?: Role[];
  createLabel?: string;
  aliases?: string[];
}

export interface PluginManifest {
  id: string;
  label: string;
  description: string;
  version: string;
  apiVersion: number;
  scope: 'platform' | 'tenant';
  core?: boolean;
  dependsOn?: string[];
  nav?: PluginNav;
}

/** User-facing error shape: English code, English message. */
export interface ErrorBody {
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
    reason?: string;
  };
}

export function errorBody(
  code: string,
  message: string,
  extra?: Partial<ErrorBody['error']>,
): ErrorBody {
  return { error: { code, message, ...(extra ?? {}) } };
}

/** Thrown by route handlers to answer with the shared error shape. */
export class FieldError extends Error {
  readonly fields: Record<string, string>;
  readonly code: string;

  constructor(fields: Record<string, string>, code = 'validation_failed') {
    super('validation_failed');
    this.name = 'FieldError';
    this.fields = fields;
    this.code = code;
  }
}

/** Paginated list envelope. */
export interface ListResponse<T> {
  items: T[];
  total: number;
  nextCursor: string | null;
}

export interface NavEntry {
  plugin: string;
  label: string;
  path: string;
  group: 'work' | 'management';
  icon: string;
  order: number;
  roles: Role[];
  createLabel: string | null;
  aliases: string[];
}

export interface NavResponse {
  items: NavEntry[];
}

/**
 * A read-only question a plugin allows the agent to ask it.
 *
 * The plugin owns the tables and the query; the agent never reads them
 * directly. `args` is a small JSON schema the agent validates before calling
 * `run`, and `href` points the operator at the page where they can check the
 * numbers themselves.
 */
export interface AgentDataSource {
  /** Dotted, unique across plugins: `tenants.summary`. */
  id: string;
  /**
   * Contract, not a hint: `run` must only read. It must not write, send,
   * start jobs or return secrets, sessions or personal data beyond what the
   * operator sees on `href`. The kernel only calls it through
   * `runAgentSource`, after validating the arguments against `args`.
   */
  readOnly: true;
  label: string;
  /** One sentence: what this source answers, in the operator's words. */
  description: string;
  /** JSON schema for the arguments; usually an empty object. */
  args: Record<string, unknown>;
  href?: string;
  run(args: Record<string, unknown>): Promise<unknown>;
}

/** What the agent shows about a source without exposing its implementation. */
export interface AgentSourceInfo {
  id: string;
  label: string;
  description: string;
  href?: string;
}

/** Info view handed to plugins: a source without its `run` function. */
export interface AgentSourceView extends AgentSourceInfo {
  args: Record<string, unknown>;
}

// --- LLM provider ----------------------------------------------------------

/**
 * Wire contract of the internal LLM route a provider plugin exposes under
 * `/api/v1/<provider>`. It mirrors the common chat-completions shape without
 * naming an vendor, so the agent does not care which model answers.
 */
export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments, exactly as the model produced them. */
  arguments: string;
}

export type LlmMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string };

export interface LlmRequest {
  messages: LlmMessage[];
  tools?: LlmToolDefinition[];
  maxOutputTokens?: number;
}

export interface LlmResponse {
  content: string;
  toolCalls: LlmToolCall[];
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LlmStatus {
  configured: boolean;
  model: string | null;
}

export interface PluginStateEntry {
  id: string;
  label: string;
  description: string;
  version: string;
  scope: 'platform' | 'tenant';
  core: boolean;
  enabled: boolean;
  drift: string[];
  routes: number;
}

export interface AuthMe {
  user: { id: string; email: string; name: string; role: Role };
  tenant: { id: string; name: string; slug: string } | null;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  version: string;
  port: number | null;
  worktree?: string;
  branch?: string;
}

// --- Plugins ---------------------------------------------------------------

export type TenantStatus = 'active' | 'suspended';

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  created_at: string;
}

export interface TenantUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  tenant_id: string | null;
}
