import type {
  PublicApproval,
  Website,
  WebsiteAiJob,
  WebsiteApproval,
  WebsiteApprovalLink,
  WebsiteApprovalState,
  WebsiteBuild,
  WebsiteBuildStatus,
  WebsiteClient,
  WebsiteDetail,
  WebsiteListItem,
  WebsiteListResponse,
  WebsitePage,
  WebsiteSettings,
  WebsiteStatus,
  WebsiteSummary,
  AgentAskResponse,
  AgentRun,
  AgentRunListResponse,
  AgentSourceInfo,
  AgentStatus,
  AgentStep,
  AuthMe,
  DiscoveryInvite,
  DiscoveryInviteCreated,
  DiscoveryInviteDetail,
  DiscoveryInviteListResponse,
  DiscoveryInviteStatus,
  DiscoveryLocale,
  DiscoveryMode,
  DiscoveryOverview,
  DiscoveryReport,
  HealthResponse,
  LoginInput,
  NavEntry,
  NavResponse,
  Role,
  SessionTenant,
  SessionUser,
  SetupInput,
  SetupStatus,
  Tenant,
  TenantListResponse,
  TenantStats,
  TenantStatus,
  LlmAuthStyle,
  LlmCapabilities,
  LlmModel,
  LlmModelInput,
  LlmProvider,
  LlmProviderInput,
  LlmProviderListResponse,
  LlmProviderTestResult,
  LlmPurpose,
  LlmUsage,
  LlmUsageListResponse,
  LlmUsageSummary,
} from './types';

const API_PREFIX = '/api/v1';
/** A question may take several model rounds; the server caps the total. */
/** A status probe is cheap; answer before the browser gives up. */
export const AGENT_STATUS_TIMEOUT_MS = 4_000;

export const AGENT_TIMEOUT_MS = 60_000;

/**
 * The public automation interview calls the model inside the request and the
 * provider may retry once, so a single step can take ~40 s. Without its own
 * budget the browser gave up at 15 s while the server was still working.
 */
export const DISCOVERY_TIMEOUT_MS = 45_000;

/**
 * Upper bound for a single request. Without it a hanging `/auth/login` would
 * leave the login spinner running forever.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Record<string, string>;

  constructor(status: number, code: string, message: string, fields: Record<string, string> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

/**
 * Reports that the platform itself is not answering.
 *
 * Fires when a request got no answer or a 5xx. It only ever reports the
 * failure, never the recovery: a healthy `/nav` or `/stats` answer says
 * nothing about a `/tenants` route that just returned 502, so a success must
 * not clear the flag. The shell drops it on the next successful health probe.
 */
let outageHandler: (() => void) | null = null;

export function setOutageHandler(handler: (() => void) | null): void {
  outageHandler = handler;
}

function reportOutage(): void {
  outageHandler?.();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPluginError(payload: unknown): boolean {
  return (
    isRecord(payload) &&
    isRecord(payload.error) &&
    typeof payload.error.code === 'string' &&
    payload.error.code.startsWith('llm_')
  );
}

function isRole(value: unknown): value is Role {
  return value === 'operator' || value === 'tenant_admin' || value === 'employee';
}

function isTenantStatus(value: unknown): value is TenantStatus {
  return value === 'active' || value === 'suspended';
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ApiError(500, 'invalid_response', `Expected string for ${label}`);
  }
  return value;
}

// --- Websites --------------------------------------------------------------

function isWebsiteStatus(value: unknown): value is WebsiteStatus {
  return value === 'draft' || value === 'live' || value === 'failed';
}

function isWebsiteBuildStatus(value: unknown): value is WebsiteBuildStatus {
  return (
    value === 'queued' ||
    value === 'running' ||
    value === 'ok' ||
    value === 'failed' ||
    value === 'cancelled'
  );
}

function isWebsiteApprovalState(value: unknown): value is WebsiteApprovalState {
  return value === 'open' || value === 'approved' || value === 'changes' || value === 'expired';
}

function asWebsiteNullableString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return asString(value, label);
}

function asWebsiteNullableNumber(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  return asNumber(value, label);
}

function parseWebsite(raw: unknown): Website {
  if (!isRecord(raw) || !isWebsiteStatus(raw.status)) {
    throw new ApiError(500, 'invalid_response', 'Invalid website payload');
  }
  return {
    id: asString(raw.id, 'website.id'),
    client_id: asWebsiteNullableString(raw.client_id, 'website.client_id'),
    name: asString(raw.name, 'website.name'),
    slug: asString(raw.slug, 'website.slug'),
    status: raw.status,
    astro_version: asString(raw.astro_version, 'website.astro_version'),
    repo: asWebsiteNullableString(raw.repo, 'website.repo'),
    branch: asWebsiteNullableString(raw.branch, 'website.branch'),
    deploy_target: asWebsiteNullableString(raw.deploy_target, 'website.deploy_target'),
    domain: asWebsiteNullableString(raw.domain, 'website.domain'),
    domain_state: asString(raw.domain_state, 'website.domain_state'),
    created_by: asString(raw.created_by, 'website.created_by'),
    created_at: asString(raw.created_at, 'website.created_at'),
    updated_at: asString(raw.updated_at, 'website.updated_at'),
  };
}

function parseWebsiteBuildSummary(
  raw: unknown,
): WebsiteBuild['status'] extends never
  ? never
  : { id: string; status: WebsiteBuildStatus; created_at: string; duration_ms: number | null } {
  if (!isRecord(raw) || !isWebsiteBuildStatus(raw.status)) {
    throw new ApiError(500, 'invalid_response', 'Invalid website build payload');
  }
  return {
    id: asString(raw.id, 'build.id'),
    status: raw.status,
    created_at: asString(raw.created_at, 'build.created_at'),
    duration_ms: asWebsiteNullableNumber(raw.duration_ms, 'build.duration_ms'),
  };
}

function parseWebsiteListItem(raw: unknown): WebsiteListItem {
  const site = parseWebsite(raw);
  if (!isRecord(raw)) throw new ApiError(500, 'invalid_response', 'Invalid website payload');
  return {
    ...site,
    client_name: asWebsiteNullableString(raw.client_name, 'website.client_name'),
    last_build: raw.last_build == null ? null : parseWebsiteBuildSummary(raw.last_build),
  };
}

function parseWebsiteDetail(raw: unknown): WebsiteDetail {
  const site = parseWebsite(raw);
  if (!isRecord(raw)) throw new ApiError(500, 'invalid_response', 'Invalid website payload');
  const client = raw.client == null ? null : (raw.client as WebsiteClient);
  const release = raw.release == null ? null : (raw.release as WebsiteDetail['release']);
  const approval =
    raw.open_approval == null ? null : (raw.open_approval as WebsiteDetail['open_approval']);
  return {
    ...site,
    client,
    pages_count: asNumber(raw.pages_count, 'website.pages_count'),
    last_build: raw.last_build == null ? null : parseWebsiteBuildSummary(raw.last_build),
    release,
    open_approval: approval,
    require_approval: raw.require_approval !== false,
  };
}

function parseWebsitePage(raw: unknown): WebsitePage {
  if (
    !isRecord(raw) ||
    (raw.origin !== 'ai' && raw.origin !== 'manual' && raw.origin !== 'template')
  ) {
    throw new ApiError(500, 'invalid_response', 'Invalid website page payload');
  }
  return {
    id: asString(raw.id, 'page.id'),
    site_id: asString(raw.site_id, 'page.site_id'),
    route: asString(raw.route, 'page.route'),
    title: asString(raw.title, 'page.title'),
    origin: raw.origin,
    created_at: asString(raw.created_at, 'page.created_at'),
    updated_at: asString(raw.updated_at, 'page.updated_at'),
  };
}

function parseWebsiteBuild(raw: unknown): WebsiteBuild {
  if (!isRecord(raw) || !isWebsiteBuildStatus(raw.status)) {
    throw new ApiError(500, 'invalid_response', 'Invalid website build payload');
  }
  return {
    id: asString(raw.id, 'build.id'),
    site_id: asString(raw.site_id, 'build.site_id'),
    trigger: asString(raw.trigger, 'build.trigger'),
    status: raw.status,
    duration_ms: asWebsiteNullableNumber(raw.duration_ms, 'build.duration_ms'),
    error_file: asWebsiteNullableString(raw.error_file, 'build.error_file'),
    created_at: asString(raw.created_at, 'build.created_at'),
    started_at: asWebsiteNullableString(raw.started_at, 'build.started_at'),
    finished_at: asWebsiteNullableString(raw.finished_at, 'build.finished_at'),
  };
}

function parseWebsiteApproval(raw: unknown): WebsiteApproval {
  if (!isRecord(raw) || !isWebsiteApprovalState(raw.state)) {
    throw new ApiError(500, 'invalid_response', 'Invalid approval payload');
  }
  return {
    id: asString(raw.id, 'approval.id'),
    site_id: asString(raw.site_id, 'approval.site_id'),
    build_id: asString(raw.build_id, 'approval.build_id'),
    recipient: asWebsiteNullableString(raw.recipient, 'approval.recipient'),
    state: raw.state,
    comment: asWebsiteNullableString(raw.comment, 'approval.comment'),
    expires_at: asString(raw.expires_at, 'approval.expires_at'),
    decided_at: asWebsiteNullableString(raw.decided_at, 'approval.decided_at'),
    created_at: asString(raw.created_at, 'approval.created_at'),
  };
}

function parseWebsiteApprovalLink(raw: unknown): WebsiteApprovalLink {
  const approval = parseWebsiteApproval(raw);
  if (!isRecord(raw)) throw new ApiError(500, 'invalid_response', 'Invalid approval payload');
  return { ...approval, url: asString(raw.url, 'approval.url') };
}

function parseWebsiteSummary(raw: unknown): WebsiteSummary {
  if (!isRecord(raw)) throw new ApiError(500, 'invalid_response', 'Invalid website summary');
  return {
    total: asNumber(raw.total, 'summary.total'),
    own: asNumber(raw.own, 'summary.own'),
    client: asNumber(raw.client, 'summary.client'),
    live: asNumber(raw.live, 'summary.live'),
    draft: asNumber(raw.draft, 'summary.draft'),
    failed: asNumber(raw.failed, 'summary.failed'),
    builds_running: asNumber(raw.builds_running, 'summary.builds_running'),
    approvals_open: asNumber(raw.approvals_open, 'summary.approvals_open'),
  };
}

function parseWebsiteList(raw: unknown): WebsiteListResponse {
  if (!isRecord(raw) || !Array.isArray(raw.items)) {
    throw new ApiError(500, 'invalid_response', 'Invalid website list');
  }
  return {
    items: raw.items.map(parseWebsiteListItem),
    total: asNumber(raw.total, 'websites.total'),
    nextCursor: raw.nextCursor === null ? null : asString(raw.nextCursor, 'websites.nextCursor'),
  };
}

function parsePublicApproval(raw: unknown): PublicApproval {
  if (!isRecord(raw) || !isWebsiteApprovalState(raw.state) || !isRecord(raw.site)) {
    throw new ApiError(500, 'invalid_response', 'Invalid public approval payload');
  }
  const build = raw.build == null ? null : (raw.build as PublicApproval['build']);
  return {
    site: {
      name: asString(raw.site.name, 'public.site.name'),
      domain: asWebsiteNullableString(raw.site.domain, 'public.site.domain'),
      status: isWebsiteStatus(raw.site.status) ? raw.site.status : 'draft',
    },
    build,
    state: raw.state,
    recipient: asWebsiteNullableString(raw.recipient, 'public.recipient'),
    expires_at: asString(raw.expires_at, 'public.expires_at'),
    pages: Array.isArray(raw.pages)
      ? raw.pages.filter(isRecord).map((page) => ({
          route: asString(page.route, 'public.page.route'),
          title: asString(page.title, 'public.page.title'),
          origin: page.origin === 'manual' || page.origin === 'template' ? page.origin : 'ai',
        }))
      : [],
    comment: asWebsiteNullableString(raw.comment, 'public.comment'),
  };
}

function asNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApiError(500, 'invalid_response', `Expected number for ${label}`);
  }
  return value;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function parseSessionUser(raw: unknown): SessionUser {
  if (!isRecord(raw) || !isRole(raw.role)) {
    throw new ApiError(500, 'invalid_response', 'Invalid session user payload');
  }
  return {
    id: asString(raw.id, 'user.id'),
    email: asString(raw.email, 'user.email'),
    name: asString(raw.name, 'user.name'),
    role: raw.role,
  };
}

function parseSessionTenant(raw: unknown): SessionTenant | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) {
    throw new ApiError(500, 'invalid_response', 'Invalid session tenant payload');
  }
  return {
    id: asString(raw.id, 'tenant.id'),
    name: asString(raw.name, 'tenant.name'),
    slug: asString(raw.slug, 'tenant.slug'),
  };
}

function parseAuthMe(raw: unknown): AuthMe {
  if (!isRecord(raw)) {
    throw new ApiError(500, 'invalid_response', 'Invalid auth payload');
  }
  return {
    user: parseSessionUser(raw.user),
    tenant: parseSessionTenant(raw.tenant),
    activeTenant: parseSessionTenant(raw.activeTenant),
  };
}

function parseSetupStatus(raw: unknown): SetupStatus {
  if (!isRecord(raw) || typeof raw.required !== 'boolean') {
    throw new ApiError(500, 'invalid_response', 'Invalid setup status payload');
  }
  return { required: raw.required };
}

function parseHealth(raw: unknown): HealthResponse {
  if (!isRecord(raw) || (raw.status !== 'ok' && raw.status !== 'degraded')) {
    throw new ApiError(500, 'invalid_response', 'Invalid health payload');
  }
  const port = raw.port === null ? null : asNumber(raw.port, 'health.port');
  return {
    status: raw.status,
    version: asString(raw.version, 'health.version'),
    port,
  };
}

function parseNavEntry(raw: unknown): NavEntry {
  if (!isRecord(raw) || (raw.group !== 'work' && raw.group !== 'management')) {
    throw new ApiError(500, 'invalid_response', 'Invalid nav entry');
  }
  // The server treats an empty role list as "visible to nobody" (`navFor`
  // filters with `roles.includes(role)`), so a missing or unreadable list must
  // fail loudly instead of silently granting the entry to every role.
  if (!Array.isArray(raw.roles) || !raw.roles.every(isRole)) {
    throw new ApiError(500, 'invalid_response', 'Invalid nav roles');
  }
  const roles = [...raw.roles];
  return {
    plugin: asString(raw.plugin, 'nav.plugin'),
    label: asString(raw.label, 'nav.label'),
    path: asString(raw.path, 'nav.path'),
    group: raw.group,
    icon: asString(raw.icon, 'nav.icon'),
    order: asNumber(raw.order, 'nav.order'),
    roles,
    createLabel: typeof raw.createLabel === 'string' ? raw.createLabel : null,
    aliases: asStringArray(raw.aliases),
  };
}

function parseNavResponse(raw: unknown): NavResponse {
  if (!isRecord(raw) || !Array.isArray(raw.items)) {
    throw new ApiError(500, 'invalid_response', 'Invalid nav payload');
  }
  return { items: raw.items.map(parseNavEntry) };
}

function parseTenant(raw: unknown): Tenant {
  if (!isRecord(raw) || !isTenantStatus(raw.status)) {
    throw new ApiError(500, 'invalid_response', 'Invalid tenant payload');
  }
  return {
    id: asString(raw.id, 'tenant.id'),
    name: asString(raw.name, 'tenant.name'),
    slug: asString(raw.slug, 'tenant.slug'),
    status: raw.status,
    created_at: asString(raw.created_at, 'tenant.created_at'),
  };
}

function parseTenantStats(raw: unknown): TenantStats {
  if (!isRecord(raw)) {
    throw new ApiError(500, 'invalid_response', 'Invalid tenant stats payload');
  }
  return {
    active: asNumber(raw.active, 'stats.active'),
    suspended: asNumber(raw.suspended, 'stats.suspended'),
    total: asNumber(raw.total, 'stats.total'),
  };
}

function parseTenantList(raw: unknown): TenantListResponse {
  if (!isRecord(raw) || !Array.isArray(raw.items)) {
    throw new ApiError(500, 'invalid_response', 'Invalid tenant list payload');
  }
  return {
    items: raw.items.map(parseTenant),
    total: asNumber(raw.total, 'tenants.total'),
    nextCursor: typeof raw.nextCursor === 'string' ? raw.nextCursor : null,
  };
}

function parseAgentSource(raw: unknown): AgentSourceInfo {
  if (!isRecord(raw)) throw new ApiError(500, 'invalid_response', 'Invalid agent source');
  return {
    id: asString(raw.id, 'agent.source.id'),
    label: asString(raw.label, 'agent.source.label'),
    description: asString(raw.description, 'agent.source.description'),
    ...(typeof raw.href === 'string' ? { href: raw.href } : {}),
  };
}

function parseAgentStep(raw: unknown): AgentStep {
  if (!isRecord(raw) || (raw.status !== 'ok' && raw.status !== 'error')) {
    throw new ApiError(500, 'invalid_response', 'Invalid agent step');
  }
  return {
    seq: asNumber(raw.seq, 'agent.step.seq'),
    source: asString(raw.source, 'agent.step.source'),
    status: raw.status,
    durationMs: asNumber(raw.durationMs, 'agent.step.durationMs'),
    ...(typeof raw.errorCode === 'string' ? { errorCode: raw.errorCode } : {}),
    truncated: raw.truncated === true,
  };
}

function parseAgentRun(raw: unknown): AgentRun {
  if (!isRecord(raw) || (raw.status !== 'ok' && raw.status !== 'error')) {
    throw new ApiError(500, 'invalid_response', 'Invalid agent run');
  }
  const steps = Array.isArray(raw.steps) ? raw.steps.map(parseAgentStep) : [];
  return {
    id: asString(raw.id, 'agent.run.id'),
    question: asString(raw.question, 'agent.run.question'),
    answer: typeof raw.answer === 'string' ? raw.answer : null,
    status: raw.status,
    errorCode: typeof raw.errorCode === 'string' ? raw.errorCode : null,
    model: typeof raw.model === 'string' ? raw.model : null,
    durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : null,
    createdAt: asString(raw.createdAt, 'agent.run.createdAt'),
    finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : null,
    steps,
  };
}

function parseAgentStatus(raw: unknown): AgentStatus {
  if (
    !isRecord(raw) ||
    typeof raw.configured !== 'boolean' ||
    typeof raw.reachable !== 'boolean' ||
    !Array.isArray(raw.sources) ||
    !isRecord(raw.limits)
  ) {
    throw new ApiError(500, 'invalid_response', 'Invalid agent status');
  }
  return {
    configured: raw.configured,
    model: typeof raw.model === 'string' ? raw.model : null,
    reachable: raw.reachable,
    retentionDays: asNumber(raw.retentionDays, 'agent.retentionDays'),
    limits: {
      perMinute: asNumber(raw.limits.perMinute, 'agent.limits.perMinute'),
      perDay: asNumber(raw.limits.perDay, 'agent.limits.perDay'),
    },
    sources: raw.sources.map(parseAgentSource),
  };
}

function parseAgentAsk(raw: unknown): AgentAskResponse {
  if (!isRecord(raw) || !Array.isArray(raw.sources)) {
    throw new ApiError(500, 'invalid_response', 'Invalid agent answer');
  }
  return {
    run: parseAgentRun(raw.run),
    sources: raw.sources.map(parseAgentSource),
    truncated: raw.truncated === true,
  };
}

function parseAgentRunList(raw: unknown): AgentRunListResponse {
  if (!isRecord(raw) || !Array.isArray(raw.items)) {
    throw new ApiError(500, 'invalid_response', 'Invalid agent run list');
  }
  return {
    items: raw.items.map(parseAgentRun),
    total: asNumber(raw.total, 'agent.total'),
    nextCursor: typeof raw.nextCursor === 'string' ? raw.nextCursor : null,
  };
}

function extractApiError(status: number, payload: unknown): ApiError {
  if (isRecord(payload) && isRecord(payload.error)) {
    const err = payload.error;
    const code = typeof err.code === 'string' ? err.code : `http_${status}`;
    const message = typeof err.message === 'string' ? err.message : `HTTP ${status}`;
    const fields: Record<string, string> = {};
    if (isRecord(err.fields)) {
      for (const [key, val] of Object.entries(err.fields)) {
        if (typeof val === 'string') fields[key] = val;
      }
    }
    return new ApiError(status, code, message, fields);
  }
  return new ApiError(status, `http_${status}`, `HTTP ${status}`);
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  notifyUnauthorized?: boolean;
  signal?: AbortSignal;
  /** Overrides the global 15 s bound for a route that may think for longer. */
  timeoutMs?: number;
}

/**
 * True for an aborted request.
 *
 * Checks `name` instead of `instanceof DOMException`: the rejection can arrive
 * as a `DOMException` or as the plain `Error` an `AbortSignal` reason carries,
 * and both must stay recognisable for the effects that ignore aborts.
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Normalise anything `fetch` threw into an error the callers understand.
 *
 * A caller abort stays untouched: effects abort on unmount and must be able to
 * ignore the rejection instead of rendering it as a failure. Everything else —
 * including the `TimeoutError` from `AbortSignal.timeout` — means the API did
 * not answer and becomes a `network_error`.
 */
export function translateFetchError(error: unknown): unknown {
  if (isAbortError(error)) return error;
  return new ApiError(0, 'network_error', 'Network request failed');
}

/** Combined caller signal and request timeout, or just the timeout. */
function requestSignal(
  signal: AbortSignal | undefined,
  timeoutMs = REQUEST_TIMEOUT_MS,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function requestJson(path: string, options: RequestOptions = {}): Promise<unknown> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  let response: Response;
  let text: string;
  // `fetch` and the body read share one `try`: an abort while the body streams
  // in rejects `response.text()` too, and used to surface as a raw TypeError.
  try {
    response = await fetch(`${API_PREFIX}${path}`, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers,
      credentials: 'same-origin',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: requestSignal(options.signal, options.timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    const failure = translateFetchError(error);
    // A caller abort says nothing about the platform's health.
    if (!isAbortError(failure)) reportOutage();
    throw failure;
  }

  let payload: unknown = null;
  let parsed = true;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      parsed = false;
    }
  }

  // Only a 5xx is an outage. A 2xx (or a 4xx the request itself caused) proves
  // nothing about the routes that are still failing, so it must not clear it.
  // A plugin's upstream failure is not a platform outage: the LLM route
  // returns 502/504 with an `llm_` code while the kernel is healthy.
  if (response.status >= 500 && !isPluginError(payload)) reportOutage();

  if (!response.ok) {
    if (response.status === 401 && options.notifyUnauthorized !== false) {
      unauthorizedHandler?.();
    }
    // A non-JSON body (an HTML error page from a proxy, a truncated stream)
    // must not become the user-facing message.
    if (!parsed) {
      throw new ApiError(response.status, `http_${response.status}`, `HTTP ${response.status}`);
    }
    throw extractApiError(response.status, payload);
  }

  return payload;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseLlmCapabilities(raw: unknown): LlmCapabilities {
  if (!isRecord(raw)) {
    return { tools: false, json: false, vision: false, embeddings: false };
  }
  return {
    tools: asBoolean(raw.tools),
    json: asBoolean(raw.json),
    vision: asBoolean(raw.vision),
    embeddings: asBoolean(raw.embeddings),
  };
}

function parseLlmAuthStyle(raw: unknown): LlmAuthStyle {
  return raw === 'header' || raw === 'none' ? raw : 'bearer';
}

function parseLlmProvider(raw: unknown): LlmProvider {
  if (!isRecord(raw)) {
    throw new ApiError(500, 'invalid_response', 'Invalid provider payload');
  }
  return {
    id: asString(raw.id, 'provider.id'),
    name: asString(raw.name, 'provider.name'),
    preset: asString(raw.preset, 'provider.preset'),
    baseUrl: asString(raw.baseUrl, 'provider.baseUrl'),
    chatPath: asString(raw.chatPath, 'provider.chatPath'),
    apiVersion: asNullableString(raw.apiVersion),
    authStyle: parseLlmAuthStyle(raw.authStyle),
    authHeader: asNullableString(raw.authHeader),
    keySet: asBoolean(raw.keySet),
    keyUpdatedAt: asNullableString(raw.keyUpdatedAt),
    extraHeaderNames: asStringArray(raw.extraHeaderNames),
    timeoutMs: asNumber(raw.timeoutMs, 'provider.timeoutMs'),
    maxRetries: asNumber(raw.maxRetries, 'provider.maxRetries'),
    rateLimitPerMinute: asNumber(raw.rateLimitPerMinute, 'provider.rateLimitPerMinute'),
    dailyTokenLimit: asNumber(raw.dailyTokenLimit, 'provider.dailyTokenLimit'),
    monthlyBudgetMicros: asNumber(raw.monthlyBudgetMicros, 'provider.monthlyBudgetMicros'),
    retentionDays: asNumber(raw.retentionDays, 'provider.retentionDays'),
    allowedPlugins: Array.isArray(raw.allowedPlugins) ? asStringArray(raw.allowedPlugins) : null,
    status: raw.status === 'disabled' ? 'disabled' : 'active',
    lastTestAt: asNullableString(raw.lastTestAt),
    lastTestStatus: asNullableString(raw.lastTestStatus),
    lastTestMs: asNullableNumber(raw.lastTestMs),
    createdAt: asString(raw.createdAt, 'provider.createdAt'),
    updatedAt: asString(raw.updatedAt, 'provider.updatedAt'),
    createdBy: asString(raw.createdBy, 'provider.createdBy'),
    modelCount: asNumber(raw.modelCount, 'provider.modelCount'),
  };
}

function parseLlmProviderList(raw: unknown): LlmProviderListResponse {
  if (!isRecord(raw) || !Array.isArray(raw.items)) {
    throw new ApiError(500, 'invalid_response', 'Invalid provider list payload');
  }
  return {
    items: raw.items.map(parseLlmProvider),
    total: asNumber(raw.total, 'providers.total'),
    nextCursor: asNullableString(raw.nextCursor),
  };
}

function parseLlmModel(raw: unknown): LlmModel {
  if (!isRecord(raw)) {
    throw new ApiError(500, 'invalid_response', 'Invalid model payload');
  }
  return {
    id: asString(raw.id, 'model.id'),
    providerId: asString(raw.providerId, 'model.providerId'),
    modelKey: asString(raw.modelKey, 'model.modelKey'),
    label: asString(raw.label, 'model.label'),
    contextWindow: asNullableNumber(raw.contextWindow),
    maxOutputTokens: asNullableNumber(raw.maxOutputTokens),
    capabilities: parseLlmCapabilities(raw.capabilities),
    inputCostMicrosPerMtok: asNumber(raw.inputCostMicrosPerMtok, 'model.inputCost'),
    outputCostMicrosPerMtok: asNumber(raw.outputCostMicrosPerMtok, 'model.outputCost'),
    isDefault: asBoolean(raw.isDefault),
    source: raw.source === 'discovered' ? 'discovered' : 'manual',
    status: raw.status === 'disabled' ? 'disabled' : 'active',
    createdAt: asString(raw.createdAt, 'model.createdAt'),
  };
}

function parseLlmPurposeModel(raw: unknown): LlmPurpose['model'] {
  if (!isRecord(raw)) return null;
  return {
    id: asString(raw.id, 'purposeModel.id'),
    modelKey: asString(raw.modelKey, 'purposeModel.modelKey'),
    label: asString(raw.label, 'purposeModel.label'),
    providerId: asString(raw.providerId, 'purposeModel.providerId'),
    providerName: asString(raw.providerName, 'purposeModel.providerName'),
    status: raw.status === 'disabled' ? 'disabled' : 'active',
    capabilities: parseLlmCapabilities(raw.capabilities),
  };
}

function parseLlmPurpose(raw: unknown): LlmPurpose {
  if (!isRecord(raw)) {
    throw new ApiError(500, 'invalid_response', 'Invalid purpose payload');
  }
  return {
    purpose: asString(raw.purpose, 'purpose.purpose'),
    description: asNullableString(raw.description),
    model: parseLlmPurposeModel(raw.model),
    fallbackModel: parseLlmPurposeModel(raw.fallbackModel),
    updatedAt: asString(raw.updatedAt, 'purpose.updatedAt'),
    updatedBy: asString(raw.updatedBy, 'purpose.updatedBy'),
    calls30d: asNumber(raw.calls30d, 'purpose.calls30d'),
  };
}

function parseLlmUsage(raw: unknown): LlmUsage {
  if (!isRecord(raw)) {
    throw new ApiError(500, 'invalid_response', 'Invalid usage payload');
  }
  return {
    id: asString(raw.id, 'usage.id'),
    providerId: asNullableString(raw.providerId),
    modelId: asNullableString(raw.modelId),
    purpose: asString(raw.purpose, 'usage.purpose'),
    caller: asString(raw.caller, 'usage.caller'),
    tenantId: asNullableString(raw.tenantId),
    status: raw.status === 'error' ? 'error' : 'ok',
    errorCode: asNullableString(raw.errorCode),
    inputTokens: asNullableNumber(raw.inputTokens),
    outputTokens: asNullableNumber(raw.outputTokens),
    costMicros: asNumber(raw.costMicros, 'usage.costMicros'),
    latencyMs: asNullableNumber(raw.latencyMs),
    requestId: asNullableString(raw.requestId),
    createdAt: asString(raw.createdAt, 'usage.createdAt'),
  };
}

function parseLlmUsageList(raw: unknown): LlmUsageListResponse {
  if (!isRecord(raw) || !Array.isArray(raw.items)) {
    throw new ApiError(500, 'invalid_response', 'Invalid usage list payload');
  }
  return {
    items: raw.items.map(parseLlmUsage),
    total: asNumber(raw.total, 'usage.total'),
    nextCursor: asNullableString(raw.nextCursor),
  };
}

function parseLlmUsageSummary(raw: unknown): LlmUsageSummary {
  if (!isRecord(raw)) {
    throw new ApiError(500, 'invalid_response', 'Invalid usage summary payload');
  }
  const byCaller = Array.isArray(raw.byCaller)
    ? raw.byCaller.filter(isRecord).map((row) => ({
        caller: asString(row.caller, 'summary.caller'),
        calls: asNumber(row.calls, 'summary.calls'),
        tokens: asNumber(row.tokens, 'summary.tokens'),
        costMicros: asNumber(row.costMicros, 'summary.cost'),
      }))
    : [];
  const byProvider = Array.isArray(raw.byProvider)
    ? raw.byProvider.filter(isRecord).map((row) => ({
        providerId: asNullableString(row.providerId),
        providerName: asNullableString(row.providerName),
        calls: asNumber(row.calls, 'summary.providerCalls'),
        costMicros: asNumber(row.costMicros, 'summary.providerCost'),
      }))
    : [];
  const byPurpose = Array.isArray(raw.byPurpose)
    ? raw.byPurpose.filter(isRecord).map((row) => ({
        purpose: asString(row.purpose, 'summary.purpose'),
        calls: asNumber(row.calls, 'summary.purposeCalls'),
        costMicros: asNumber(row.costMicros, 'summary.purposeCost'),
      }))
    : [];
  return {
    days: asNumber(raw.days, 'summary.days'),
    calls: asNumber(raw.calls, 'summary.calls'),
    ok: asNumber(raw.ok, 'summary.ok'),
    errors: asNumber(raw.errors, 'summary.errors'),
    inputTokens: asNumber(raw.inputTokens, 'summary.inputTokens'),
    outputTokens: asNumber(raw.outputTokens, 'summary.outputTokens'),
    costMicros: asNumber(raw.costMicros, 'summary.costMicros'),
    byCaller,
    byProvider,
    byPurpose,
  };
}

function parseLlmTest(raw: unknown): LlmProviderTestResult {
  if (!isRecord(raw) || typeof raw.ok !== 'boolean') {
    throw new ApiError(500, 'invalid_response', 'Invalid provider test payload');
  }
  return {
    ok: raw.ok,
    latencyMs: asNumber(raw.latencyMs, 'test.latencyMs'),
    ...(typeof raw.code === 'string' ? { code: raw.code } : {}),
    ...(typeof raw.message === 'string' ? { message: raw.message } : {}),
    ...(Array.isArray(raw.models)
      ? {
          models: raw.models
            .filter(isRecord)
            .map((model) => ({ modelKey: asString(model.modelKey, 'test.modelKey') })),
        }
      : {}),
  };
}

export const api = {
  async health(signal?: AbortSignal): Promise<HealthResponse> {
    return parseHealth(await requestJson('/health', { notifyUnauthorized: false, signal }));
  },

  async me(signal?: AbortSignal): Promise<AuthMe> {
    return parseAuthMe(await requestJson('/auth/me', { notifyUnauthorized: false, signal }));
  },

  /**
   * Public: the login page asks this before rendering a form. A failed probe is
   * not a 401 and must never touch the session state, so the handler stays off.
   */
  async setupStatus(signal?: AbortSignal): Promise<SetupStatus> {
    return parseSetupStatus(
      await requestJson('/auth/setup', { notifyUnauthorized: false, signal }),
    );
  },

  async setup(input: SetupInput): Promise<AuthMe> {
    return parseAuthMe(
      await requestJson('/auth/setup', {
        method: 'POST',
        body: input,
        notifyUnauthorized: false,
      }),
    );
  },

  async login(input: LoginInput): Promise<AuthMe> {
    return parseAuthMe(
      await requestJson('/auth/login', {
        method: 'POST',
        body: input,
        notifyUnauthorized: false,
      }),
    );
  },

  async logout(): Promise<void> {
    await requestJson('/auth/logout', { method: 'POST', notifyUnauthorized: false });
  },

  /**
   * Operator only: choose the tenant this session works in, or `null` to leave
   * it. The choice lives in the server-side session.
   */
  async setActiveTenant(tenantId: string | null, signal?: AbortSignal): Promise<AuthMe> {
    return parseAuthMe(
      await requestJson('/auth/tenant', {
        method: 'POST',
        body: { tenantId },
        signal,
      }),
    );
  },

  async nav(signal?: AbortSignal): Promise<NavResponse> {
    return parseNavResponse(await requestJson('/nav', { signal }));
  },

  async tenantStats(signal?: AbortSignal): Promise<TenantStats> {
    return parseTenantStats(await requestJson('/tenants/stats', { signal }));
  },

  async listTenants(
    params: {
      status?: TenantStatus;
      q?: string;
      limit?: number;
      cursor?: string | null;
    },
    signal?: AbortSignal,
  ): Promise<TenantListResponse> {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.q && params.q.trim().length > 0) query.set('q', params.q.trim());
    if (params.limit) query.set('limit', String(params.limit));
    if (params.cursor) query.set('cursor', params.cursor);
    const suffix = query.toString();
    const path = suffix.length > 0 ? `/tenants?${suffix}` : '/tenants';
    return parseTenantList(await requestJson(path, { signal }));
  },

  async createTenant(input: { name: string; slug?: string }): Promise<Tenant> {
    const body =
      input.slug && input.slug.trim().length > 0
        ? { name: input.name, slug: input.slug.trim() }
        : { name: input.name };
    return parseTenant(await requestJson('/tenants', { method: 'POST', body }));
  },

  async suspendTenant(id: string): Promise<Tenant> {
    return parseTenant(
      await requestJson(`/tenants/${encodeURIComponent(id)}/suspend`, { method: 'POST' }),
    );
  },

  async resumeTenant(id: string): Promise<Tenant> {
    return parseTenant(
      await requestJson(`/tenants/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
    );
  },

  // --- Automatisierungs-Scout ---------------------------------------------

  async listDiscoveryInvites(
    params: { status?: DiscoveryInviteStatus; q?: string; limit?: number; cursor?: string | null },
    signal?: AbortSignal,
  ): Promise<DiscoveryInviteListResponse> {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.q && params.q.trim().length > 0) query.set('q', params.q.trim());
    if (params.limit) query.set('limit', String(params.limit));
    if (params.cursor) query.set('cursor', params.cursor);
    const suffix = query.toString();
    const raw = await requestJson(
      suffix.length > 0 ? `/discovery/invites?${suffix}` : '/discovery/invites',
      { signal },
    );
    return raw as DiscoveryInviteListResponse;
  },

  async createDiscoveryInvite(input: {
    customerName: string;
    contactEmail?: string;
    locale?: DiscoveryLocale;
    mode?: DiscoveryMode;
    expiresInDays?: number;
    tenantId?: string;
  }): Promise<DiscoveryInviteCreated> {
    return (await requestJson('/discovery/invites', {
      method: 'POST',
      body: input,
    })) as DiscoveryInviteCreated;
  },

  async getDiscoveryInvite(id: string, signal?: AbortSignal): Promise<DiscoveryInviteDetail> {
    return (await requestJson(`/discovery/invites/${encodeURIComponent(id)}`, {
      signal,
    })) as DiscoveryInviteDetail;
  },

  async revokeDiscoveryInvite(id: string): Promise<{ invite: DiscoveryInvite }> {
    return (await requestJson(`/discovery/invites/${encodeURIComponent(id)}/revoke`, {
      method: 'POST',
    })) as { invite: DiscoveryInvite };
  },

  async resendDiscoveryInvite(id: string): Promise<DiscoveryInviteCreated> {
    return (await requestJson(`/discovery/invites/${encodeURIComponent(id)}/resend`, {
      method: 'POST',
    })) as DiscoveryInviteCreated;
  },

  async getDiscoveryReport(id: string): Promise<{ report: DiscoveryReport }> {
    return (await requestJson(`/discovery/invites/${encodeURIComponent(id)}/report`)) as {
      report: DiscoveryReport;
    };
  },

  async discoveryOverview(signal?: AbortSignal): Promise<DiscoveryOverview> {
    return (await requestJson('/discovery/overview', { signal })) as DiscoveryOverview;
  },

  async listLlmProviders(
    params: { status?: 'active' | 'disabled'; q?: string; limit?: number; cursor?: string | null },
    signal?: AbortSignal,
  ): Promise<LlmProviderListResponse> {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.q && params.q.trim().length > 0) query.set('q', params.q.trim());
    if (params.limit) query.set('limit', String(params.limit));
    if (params.cursor) query.set('cursor', params.cursor);
    const suffix = query.toString();
    return parseLlmProviderList(
      await requestJson(suffix.length > 0 ? `/llm/providers?${suffix}` : '/llm/providers', {
        signal,
      }),
    );
  },

  async getLlmProvider(id: string, signal?: AbortSignal): Promise<LlmProvider> {
    return parseLlmProvider(
      await requestJson(`/llm/providers/${encodeURIComponent(id)}`, { signal }),
    );
  },

  async createLlmProvider(input: LlmProviderInput): Promise<LlmProvider> {
    return parseLlmProvider(await requestJson('/llm/providers', { method: 'POST', body: input }));
  },

  async updateLlmProvider(id: string, input: Partial<LlmProviderInput>): Promise<LlmProvider> {
    return parseLlmProvider(
      await requestJson(`/llm/providers/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: input,
      }),
    );
  },

  async deleteLlmProvider(id: string): Promise<void> {
    await requestJson(`/llm/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async testLlmProvider(
    input: Partial<LlmProviderInput> & { providerId?: string },
  ): Promise<LlmProviderTestResult> {
    return parseLlmTest(await requestJson('/llm/providers/test', { method: 'POST', body: input }));
  },

  async testStoredLlmProvider(id: string): Promise<LlmProviderTestResult> {
    return parseLlmTest(
      await requestJson(`/llm/providers/${encodeURIComponent(id)}/test`, { method: 'POST' }),
    );
  },

  async listLlmModels(providerId: string, signal?: AbortSignal): Promise<LlmModel[]> {
    const raw = await requestJson(`/llm/providers/${encodeURIComponent(providerId)}/models`, {
      signal,
    });
    if (!isRecord(raw) || !Array.isArray(raw.items)) {
      throw new ApiError(500, 'invalid_response', 'Invalid model list payload');
    }
    return raw.items.map(parseLlmModel);
  },

  async createLlmModel(providerId: string, input: LlmModelInput): Promise<LlmModel> {
    return parseLlmModel(
      await requestJson(`/llm/providers/${encodeURIComponent(providerId)}/models`, {
        method: 'POST',
        body: input,
      }),
    );
  },

  async updateLlmModel(id: string, input: Partial<LlmModelInput>): Promise<LlmModel> {
    return parseLlmModel(
      await requestJson(`/llm/models/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: input,
      }),
    );
  },

  async deleteLlmModel(id: string): Promise<void> {
    await requestJson(`/llm/models/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async refreshLlmModels(providerId: string): Promise<Array<{ modelKey: string }>> {
    const raw = await requestJson(
      `/llm/providers/${encodeURIComponent(providerId)}/models/refresh`,
      { method: 'POST' },
    );
    if (!isRecord(raw) || !Array.isArray(raw.items)) {
      throw new ApiError(500, 'invalid_response', 'Invalid refresh payload');
    }
    return raw.items
      .filter(isRecord)
      .map((item) => ({ modelKey: asString(item.modelKey, 'refresh.modelKey') }));
  },

  async listLlmPurposes(signal?: AbortSignal): Promise<LlmPurpose[]> {
    const raw = await requestJson('/llm/purposes', { signal });
    if (!isRecord(raw) || !Array.isArray(raw.items)) {
      throw new ApiError(500, 'invalid_response', 'Invalid purpose list payload');
    }
    return raw.items.map(parseLlmPurpose);
  },

  async createLlmPurpose(input: {
    purpose: string;
    modelId?: string | null;
    fallbackModelId?: string | null;
    description?: string | null;
  }): Promise<LlmPurpose> {
    return parseLlmPurpose(await requestJson('/llm/purposes', { method: 'POST', body: input }));
  },

  async updateLlmPurpose(
    purpose: string,
    input: {
      modelId?: string | null;
      fallbackModelId?: string | null;
      description?: string | null;
    },
  ): Promise<LlmPurpose> {
    return parseLlmPurpose(
      await requestJson(`/llm/purposes/${encodeURIComponent(purpose)}`, {
        method: 'PATCH',
        body: input,
      }),
    );
  },

  async deleteLlmPurpose(purpose: string): Promise<void> {
    await requestJson(`/llm/purposes/${encodeURIComponent(purpose)}`, { method: 'DELETE' });
  },

  async listLlmUsage(
    params: {
      days?: number;
      caller?: string;
      purpose?: string;
      status?: 'ok' | 'error';
      providerId?: string;
      limit?: number;
      cursor?: string | null;
    },
    signal?: AbortSignal,
  ): Promise<LlmUsageListResponse> {
    const query = new URLSearchParams();
    if (params.days) query.set('days', String(params.days));
    if (params.caller) query.set('caller', params.caller);
    if (params.purpose) query.set('purpose', params.purpose);
    if (params.status) query.set('status', params.status);
    if (params.providerId) query.set('providerId', params.providerId);
    if (params.limit) query.set('limit', String(params.limit));
    if (params.cursor) query.set('cursor', params.cursor);
    const suffix = query.toString();
    return parseLlmUsageList(
      await requestJson(suffix.length > 0 ? `/llm/usage?${suffix}` : '/llm/usage', { signal }),
    );
  },

  async llmUsageSummary(days = 30, signal?: AbortSignal): Promise<LlmUsageSummary> {
    return parseLlmUsageSummary(await requestJson(`/llm/usage/summary?days=${days}`, { signal }));
  },

  async listWebsites(
    params: {
      status?: WebsiteStatus;
      owner?: 'own' | 'client';
      q?: string;
      limit?: number;
      cursor?: string | null;
    },
    signal?: AbortSignal,
  ): Promise<WebsiteListResponse> {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.owner) query.set('owner', params.owner);
    if (params.q && params.q.trim().length > 0) query.set('q', params.q.trim());
    if (params.limit) query.set('limit', String(params.limit));
    if (params.cursor) query.set('cursor', params.cursor);
    const suffix = query.toString();
    return parseWebsiteList(
      await requestJson(suffix.length > 0 ? `/websites?${suffix}` : '/websites', { signal }),
    );
  },

  async websiteSummary(signal?: AbortSignal): Promise<WebsiteSummary> {
    return parseWebsiteSummary(await requestJson('/websites/summary', { signal }));
  },

  async getWebsite(id: string, signal?: AbortSignal): Promise<WebsiteDetail> {
    return parseWebsiteDetail(await requestJson(`/websites/${encodeURIComponent(id)}`, { signal }));
  },

  async createWebsite(input: {
    name: string;
    client_id?: string | null;
    domain?: string;
    repo?: string;
    deploy_target?: string;
  }): Promise<WebsiteDetail> {
    return parseWebsiteDetail(await requestJson('/websites', { method: 'POST', body: input }));
  },

  async deleteWebsite(id: string): Promise<void> {
    await requestJson(`/websites/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async websitePages(id: string, signal?: AbortSignal): Promise<WebsitePage[]> {
    const raw = await requestJson(`/websites/${encodeURIComponent(id)}/pages`, { signal });
    if (!isRecord(raw) || !Array.isArray(raw.items)) {
      throw new ApiError(500, 'invalid_response', 'Invalid page list');
    }
    return raw.items.map(parseWebsitePage);
  },

  async websiteBuilds(id: string, signal?: AbortSignal): Promise<WebsiteBuild[]> {
    const raw = await requestJson(`/websites/${encodeURIComponent(id)}/builds`, { signal });
    if (!isRecord(raw) || !Array.isArray(raw.items)) {
      throw new ApiError(500, 'invalid_response', 'Invalid build list');
    }
    return raw.items.map(parseWebsiteBuild);
  },

  async queueWebsiteBuild(id: string): Promise<WebsiteBuild> {
    return parseWebsiteBuild(
      await requestJson(`/websites/${encodeURIComponent(id)}/builds`, {
        method: 'POST',
        body: {},
      }),
    );
  },

  async websiteApprovals(id: string, signal?: AbortSignal): Promise<WebsiteApproval[]> {
    const raw = await requestJson(`/websites/${encodeURIComponent(id)}/approvals`, { signal });
    if (!isRecord(raw) || !Array.isArray(raw.items)) {
      throw new ApiError(500, 'invalid_response', 'Invalid approval list');
    }
    return raw.items.map(parseWebsiteApproval);
  },

  async createWebsiteApproval(
    id: string,
    input: { build_id: string; recipient?: string; expires_in_days?: number },
  ): Promise<WebsiteApprovalLink> {
    return parseWebsiteApprovalLink(
      await requestJson(`/websites/${encodeURIComponent(id)}/approvals`, {
        method: 'POST',
        body: input,
      }),
    );
  },

  async publishWebsite(id: string, buildId: string): Promise<{ version: string }> {
    const raw = await requestJson(`/websites/${encodeURIComponent(id)}/releases`, {
      method: 'POST',
      body: { build_id: buildId },
    });
    if (!isRecord(raw)) throw new ApiError(500, 'invalid_response', 'Invalid release payload');
    return { version: asString(raw.version, 'release.version') };
  },

  async createWebsiteJob(
    id: string,
    input: { goal: string; tone?: string; pages?: string[]; max_tokens?: number },
  ): Promise<WebsiteAiJob> {
    const raw = await requestJson(`/websites/${encodeURIComponent(id)}/jobs`, {
      method: 'POST',
      body: input,
    });
    if (!isRecord(raw) || !isRecord(raw.brief)) {
      throw new ApiError(500, 'invalid_response', 'Invalid AI job payload');
    }
    const brief = raw.brief;
    return {
      id: asString(raw.id, 'job.id'),
      site_id: asString(raw.site_id, 'job.site_id'),
      status: 'queued',
      provider: asString(raw.provider, 'job.provider'),
      model: asString(raw.model, 'job.model'),
      brief: {
        goal: asString(brief.goal, 'job.goal'),
        tone: asString(brief.tone, 'job.tone'),
        pages: asStringArray(brief.pages),
        sources: asString(brief.sources, 'job.sources'),
        max_tokens: asNumber(brief.max_tokens, 'job.max_tokens'),
      },
      created_at: asString(raw.created_at, 'job.created_at'),
    };
  },

  async websiteClients(q?: string, signal?: AbortSignal): Promise<WebsiteClient[]> {
    const suffix = q && q.trim().length > 0 ? `?q=${encodeURIComponent(q.trim())}` : '';
    const raw = await requestJson(`/websites/clients${suffix}`, { signal });
    if (!isRecord(raw) || !Array.isArray(raw.items)) {
      throw new ApiError(500, 'invalid_response', 'Invalid client list');
    }
    return raw.items as WebsiteClient[];
  },

  async createWebsiteClient(input: {
    name: string;
    contact_name?: string;
    contact_email?: string;
  }): Promise<WebsiteClient> {
    const raw = await requestJson('/websites/clients', { method: 'POST', body: input });
    if (!isRecord(raw)) throw new ApiError(500, 'invalid_response', 'Invalid client payload');
    return raw as unknown as WebsiteClient;
  },

  async websiteSettings(signal?: AbortSignal): Promise<WebsiteSettings> {
    const raw = await requestJson('/websites/settings', { signal });
    if (!isRecord(raw)) throw new ApiError(500, 'invalid_response', 'Invalid settings');
    return raw as unknown as WebsiteSettings;
  },

  async updateWebsiteSettings(input: Partial<WebsiteSettings>): Promise<WebsiteSettings> {
    const raw = await requestJson('/websites/settings', { method: 'PUT', body: input });
    if (!isRecord(raw)) throw new ApiError(500, 'invalid_response', 'Invalid settings');
    return raw as unknown as WebsiteSettings;
  },

  async publicApproval(
    tenantId: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<PublicApproval> {
    return parsePublicApproval(
      await requestJson(
        `/public/websites/${encodeURIComponent(tenantId)}/approvals/${encodeURIComponent(token)}`,
        { signal, notifyUnauthorized: false },
      ),
    );
  },

  async decidePublicApproval(
    tenantId: string,
    token: string,
    decision: 'approve' | 'changes',
    comment?: string,
  ): Promise<{ state: WebsiteApprovalState }> {
    const raw = await requestJson(
      `/public/websites/${encodeURIComponent(tenantId)}/approvals/${encodeURIComponent(token)}/decision`,
      {
        method: 'POST',
        body: { decision, ...(comment ? { comment } : {}) },
        notifyUnauthorized: false,
      },
    );
    if (!isRecord(raw) || !isWebsiteApprovalState(raw.state)) {
      throw new ApiError(500, 'invalid_response', 'Invalid decision payload');
    }
    return { state: raw.state };
  },

  async agentStatus(signal?: AbortSignal): Promise<AgentStatus> {
    return parseAgentStatus(
      await requestJson('/agent/status', { signal, timeoutMs: AGENT_STATUS_TIMEOUT_MS }),
    );
  },

  /**
   * The model may take several rounds; the route is bounded by the server's
   * own budget, so the client waits longer than the default 15 s.
   */
  async agentAsk(question: string, signal?: AbortSignal): Promise<AgentAskResponse> {
    return parseAgentAsk(
      await requestJson('/agent/ask', {
        method: 'POST',
        body: { question },
        timeoutMs: AGENT_TIMEOUT_MS,
        signal,
      }),
    );
  },

  async agentRuns(
    params: { limit?: number; cursor?: string | null } = {},
    signal?: AbortSignal,
  ): Promise<AgentRunListResponse> {
    const query = new URLSearchParams();
    if (params.limit) query.set('limit', String(params.limit));
    if (params.cursor) query.set('cursor', params.cursor);
    const suffix = query.toString();
    return parseAgentRunList(
      await requestJson(suffix.length > 0 ? `/agent/runs?${suffix}` : '/agent/runs', { signal }),
    );
  },

  async agentRun(id: string, signal?: AbortSignal): Promise<AgentRun> {
    return parseAgentRun(await requestJson(`/agent/runs/${encodeURIComponent(id)}`, { signal }));
  },
};

export interface DiscoveryPublicResponse {
  status: number;
  payload: unknown;
}

/**
 * The public interview has no session and must not send the operator cookie.
 * A completed link answers 410 with the finished report on purpose, so that
 * status is data here, not an error. Everything else keeps the shared error
 * shape.
 */
async function requestPublic(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<DiscoveryPublicResponse> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${API_PREFIX}${path}`, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers,
      credentials: 'omit',
      cache: 'no-store',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: requestSignal(options.signal, options.timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    throw translateFetchError(error);
  }
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (response.status >= 500) {
    throw extractApiError(response.status, payload);
  }
  if (response.status === 410) {
    return { status: 410, payload };
  }
  if (!response.ok) {
    throw extractApiError(response.status, payload);
  }
  return { status: response.status, payload };
}

export const discoveryPublic = {
  async state(token: string, signal?: AbortSignal): Promise<DiscoveryPublicResponse> {
    return requestPublic(`/discovery/public/${encodeURIComponent(token)}`, { signal });
  },

  async saveAnswers(
    token: string,
    answers: Array<{ key: string; value: unknown }>,
  ): Promise<DiscoveryPublicResponse> {
    return requestPublic(`/discovery/public/${encodeURIComponent(token)}/answers`, {
      body: { answers },
    });
  },

  /**
   * May call the model (hint, topic suggestions) and the provider retries
   * once, so this step gets a budget beyond the default 15 s.
   */
  async advance(token: string, shortcut = false): Promise<DiscoveryPublicResponse> {
    return requestPublic(`/discovery/public/${encodeURIComponent(token)}/advance`, {
      body: { shortcut },
      timeoutMs: DISCOVERY_TIMEOUT_MS,
    });
  },

  async contact(token: string, wanted: boolean, way: string): Promise<DiscoveryPublicResponse> {
    return requestPublic(`/discovery/public/${encodeURIComponent(token)}/contact`, {
      body: { wanted, way },
    });
  },

  /** Writes the full report: 4000 output tokens plus one retry can take ~40 s. */
  async complete(token: string): Promise<DiscoveryPublicResponse> {
    return requestPublic(`/discovery/public/${encodeURIComponent(token)}/complete`, {
      method: 'POST',
      body: {},
      timeoutMs: DISCOVERY_TIMEOUT_MS,
    });
  },
};
