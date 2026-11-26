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

/** Public answer to `GET /auth/setup`: is the first account still missing? */
export interface SetupStatus {
  required: boolean;
}

export interface SetupInput {
  email: string;
  name: string;
  password: string;
}

export interface LoginInput {
  email: string;
  password: string;
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

// --- Automatisierungs-Scout -------------------------------------------------

export type DiscoveryInviteStatus = 'open' | 'in_progress' | 'completed' | 'revoked' | 'expired';
export type DiscoveryMode = 'short' | 'standard' | 'full';
export type DiscoveryLocale = 'de' | 'en';
export type DiscoveryPhase = 'consent' | 'map' | 'clusters' | 'deepen' | 'confirm';
export type DiscoveryFieldKind =
  'text' | 'single' | 'multi' | 'rank' | 'number' | 'scale' | 'yesno';

export interface DiscoveryLocalizedText {
  de: string;
  en: string;
}

export interface DiscoveryFieldOption {
  value: string;
  label: DiscoveryLocalizedText;
}

export interface DiscoveryField {
  key: string;
  kind: DiscoveryFieldKind;
  label: DiscoveryLocalizedText;
  help?: DiscoveryLocalizedText;
  required: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
  minSelections?: number;
  maxSelections?: number;
  options?: DiscoveryFieldOption[];
}

export interface DiscoveryStep {
  key: string;
  phase: DiscoveryPhase;
  pending: boolean;
  fields: DiscoveryField[];
}

export interface DiscoverySuggestedCluster {
  id: string;
  reason?: string;
  label: DiscoveryLocalizedText;
}

export interface DiscoveryIdea {
  id: string;
  title: string;
  why: string | null;
}

export interface DiscoveryOpportunity {
  title: string;
  benefit: string;
  effort: string;
  risk: string;
  dataMaturity: string;
  rationale: string;
}

export interface DiscoveryReport {
  summary: string;
  clusters: Array<{ id: string; title: string; summary: string }>;
  opportunities: DiscoveryOpportunity[];
  quickWins: string[];
  openQuestions: string[];
  nextStep: string;
}

export interface DiscoveryPublicState {
  status: DiscoveryInviteStatus;
  locale: DiscoveryLocale;
  customerName: string;
  mode: DiscoveryMode;
  expiresAt: string;
  phase: DiscoveryPhase;
  stepIndex: number;
  progress: number;
  step: DiscoveryStep | null;
  answers: Record<string, unknown>;
  clusters: { suggested: DiscoverySuggestedCluster[]; selected: string[] } | null;
  ideas: DiscoveryIdea[];
  canComplete: boolean;
  completedAt: string | null;
  report: DiscoveryReport | null;
}

export interface DiscoveryInvite {
  id: string;
  tenantId: string | null;
  customerName: string;
  contactEmail: string | null;
  locale: DiscoveryLocale;
  mode: DiscoveryMode;
  status: DiscoveryInviteStatus;
  expiresAt: string;
  createdAt: string;
  createdBy: string;
  completedAt: string | null;
  revokedAt: string | null;
  session: {
    id: string;
    phase: DiscoveryPhase;
    progress: number;
    startedAt: string;
    lastSeenAt: string;
    completedAt: string | null;
  } | null;
  reportAvailable: boolean;
}

export interface DiscoveryInviteListResponse {
  items: DiscoveryInvite[];
  total: number;
  nextCursor: string | null;
}

export interface DiscoveryInviteAnswer {
  key: string;
  label?: string;
  value: unknown;
  source: 'customer' | 'ai_suggested';
  updatedAt: string;
}

export interface DiscoveryInviteDetail {
  invite: DiscoveryInvite;
  answers: DiscoveryInviteAnswer[];
  report: DiscoveryReport | null;
  reportModel: string | null;
}

export interface DiscoveryInviteCreated {
  invite: DiscoveryInvite;
  link: string;
  mailSent: boolean;
  mailNote: string;
}

export interface DiscoveryOverview {
  counts: Record<DiscoveryInviteStatus, number>;
  recent: Array<{
    id: string;
    customerName: string;
    status: DiscoveryInviteStatus;
    locale: DiscoveryLocale;
    mode: DiscoveryMode;
    createdAt: string;
    expiresAt: string;
    phase: DiscoveryPhase | null;
    progress: number;
    lastSeenAt: string | null;
    reportAvailable: boolean;
  }>;
}

export type LlmAuthStyle = 'bearer' | 'header' | 'none';
export type LlmProviderStatus = 'active' | 'disabled';
export type LlmModelStatus = 'active' | 'disabled';

export interface LlmCapabilities {
  tools: boolean;
  json: boolean;
  vision: boolean;
  embeddings: boolean;
}

export interface LlmProvider {
  id: string;
  name: string;
  preset: string;
  baseUrl: string;
  chatPath: string;
  apiVersion: string | null;
  authStyle: LlmAuthStyle;
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
  status: LlmProviderStatus;
  lastTestAt: string | null;
  lastTestStatus: string | null;
  lastTestMs: number | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  modelCount: number;
}

export interface LlmProviderListResponse {
  items: LlmProvider[];
  total: number;
  nextCursor: string | null;
}

export interface LlmModel {
  id: string;
  providerId: string;
  modelKey: string;
  label: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  capabilities: LlmCapabilities;
  inputCostMicrosPerMtok: number;
  outputCostMicrosPerMtok: number;
  isDefault: boolean;
  source: 'manual' | 'discovered';
  status: LlmModelStatus;
  createdAt: string;
}

export interface LlmPurposeModel {
  id: string;
  modelKey: string;
  label: string;
  providerId: string;
  providerName: string;
  status: LlmModelStatus;
  capabilities: LlmCapabilities;
}

export interface LlmPurpose {
  purpose: string;
  description: string | null;
  model: LlmPurposeModel | null;
  fallbackModel: LlmPurposeModel | null;
  updatedAt: string;
  updatedBy: string;
  calls30d: number;
}

export interface LlmUsage {
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

export interface LlmUsageListResponse {
  items: LlmUsage[];
  total: number;
  nextCursor: string | null;
}

export interface LlmUsageSummary {
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

export interface LlmProviderTestResult {
  ok: boolean;
  latencyMs: number;
  code?: string;
  message?: string;
  models?: Array<{ modelKey: string }>;
}

export interface LlmProviderInput {
  name: string;
  preset?: string;
  baseUrl: string;
  chatPath?: string;
  apiVersion?: string | null;
  authStyle?: LlmAuthStyle;
  authHeader?: string | null;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  rateLimitPerMinute?: number;
  dailyTokenLimit?: number;
  monthlyBudgetMicros?: number;
  retentionDays?: number;
  allowedPlugins?: string[] | null;
  status?: LlmProviderStatus;
}

export interface LlmModelInput {
  modelKey: string;
  label?: string;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  capabilities?: Partial<LlmCapabilities>;
  inputCostMicrosPerMtok?: number;
  outputCostMicrosPerMtok?: number;
  isDefault?: boolean;
  source?: 'manual' | 'discovered';
  status?: LlmModelStatus;
}
