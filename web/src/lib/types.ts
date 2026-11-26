export type Role = 'operator' | 'tenant_admin' | 'employee';

export type TenantStatus = 'active' | 'suspended';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface SessionTenant {
  id: string;
  name: string;
  slug: string;
}

export interface AuthMe {
  user: SessionUser;
  tenant: SessionTenant | null;
}

export interface MagicLinkResponse {
  sent: boolean;
  expiresAt: string;
  link?: string;
  autoLogin?: boolean;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  version: string;
  port: number | null;
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

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  created_at: string;
}

export interface TenantStats {
  active: number;
  suspended: number;
  total: number;
}

export interface TenantListResponse {
  items: Tenant[];
  total: number;
  nextCursor: string | null;
}
