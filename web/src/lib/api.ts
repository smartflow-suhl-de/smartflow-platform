import type {
  AuthMe,
  HealthResponse,
  MagicLinkResponse,
  NavEntry,
  NavResponse,
  Role,
  SessionTenant,
  SessionUser,
  Tenant,
  TenantListResponse,
  TenantStats,
  TenantStatus,
} from './types';

const API_PREFIX = '/api/v1';

/**
 * Upper bound for a single request. Without it a hanging `/auth/confirm` would
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
 * Reports whether the platform itself is answering.
 *
 * `true` when a request got no answer or a 5xx, `false` as soon as any response
 * with a non-5xx status arrives. The shell uses it to stop claiming "system
 * nominal" while a data route is failing.
 */
let outageHandler: ((outage: boolean) => void) | null = null;

export function setOutageHandler(handler: ((outage: boolean) => void) | null): void {
  outageHandler = handler;
}

function reportOutage(outage: boolean): void {
  outageHandler?.(outage);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  };
}

function parseMagicLink(raw: unknown): MagicLinkResponse {
  if (!isRecord(raw) || typeof raw.sent !== 'boolean') {
    throw new ApiError(500, 'invalid_response', 'Invalid magic link payload');
  }
  return {
    sent: raw.sent,
    expiresAt: asString(raw.expiresAt, 'expiresAt'),
    ...(typeof raw.link === 'string' ? { link: raw.link } : {}),
    ...(typeof raw.autoLogin === 'boolean' ? { autoLogin: raw.autoLogin } : {}),
  };
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
  method?: 'GET' | 'POST';
  body?: unknown;
  notifyUnauthorized?: boolean;
  signal?: AbortSignal;
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
function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
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
      signal: requestSignal(options.signal),
    });
    text = await response.text();
  } catch (error) {
    const failure = translateFetchError(error);
    // A caller abort says nothing about the platform's health.
    if (!isAbortError(failure)) reportOutage(true);
    throw failure;
  }

  // Any answer below 500 means the platform is up, whatever it says about the
  // request itself.
  reportOutage(response.status >= 500);

  let payload: unknown = null;
  let parsed = true;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      parsed = false;
    }
  }

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

export const api = {
  async health(signal?: AbortSignal): Promise<HealthResponse> {
    return parseHealth(await requestJson('/health', { notifyUnauthorized: false, signal }));
  },

  async me(signal?: AbortSignal): Promise<AuthMe> {
    return parseAuthMe(await requestJson('/auth/me', { notifyUnauthorized: false, signal }));
  },

  async requestMagicLink(email: string): Promise<MagicLinkResponse> {
    return parseMagicLink(
      await requestJson('/auth/magic-link', {
        method: 'POST',
        body: { email },
        notifyUnauthorized: false,
      }),
    );
  },

  async confirmMagicLink(token: string): Promise<AuthMe> {
    return parseAuthMe(
      await requestJson('/auth/confirm', {
        method: 'POST',
        body: { token },
        notifyUnauthorized: false,
      }),
    );
  },

  async logout(): Promise<void> {
    await requestJson('/auth/logout', { method: 'POST', notifyUnauthorized: false });
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
};
