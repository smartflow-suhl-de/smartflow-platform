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
