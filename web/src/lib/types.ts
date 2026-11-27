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
  activeTenant: SessionTenant | null;
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
  group: 'work' | 'tools' | 'management';
  icon: string;
  order: number;
  roles: Role[];
  createLabel: string | null;
  aliases: string[];
}

export interface NavResponse {
  items: NavEntry[];
}

/** Display order of the master-data fields; the edit mask iterates this. */
export const TENANT_DETAIL_FIELDS = [
  'legal_name',
  'legal_form',
  'customer_number',
  'industry',
  'street',
  'address_extra',
  'postal_code',
  'city',
  'country',
  'contact_name',
  'contact_role',
  'contact_email',
  'contact_phone',
  'contact_mobile',
  'email',
  'phone',
  'website',
  'vat_id',
  'tax_number',
  'register_court',
  'register_number',
  'notes',
] as const;

export type TenantDetailField = (typeof TENANT_DETAIL_FIELDS)[number];

/** Mirrors the API limits so the browser stops typing before a 422. */
export const TENANT_DETAIL_MAX_LENGTH: Record<TenantDetailField, number> = {
  legal_name: 160,
  legal_form: 60,
  customer_number: 40,
  industry: 80,
  street: 120,
  address_extra: 120,
  postal_code: 12,
  city: 80,
  country: 60,
  contact_name: 120,
  contact_role: 80,
  contact_email: 160,
  contact_phone: 40,
  contact_mobile: 40,
  email: 160,
  phone: 40,
  website: 160,
  vat_id: 32,
  tax_number: 32,
  register_court: 80,
  register_number: 60,
  notes: 2000,
};

export interface TenantDetails {
  legal_name: string | null;
  legal_form: string | null;
  customer_number: string | null;
  industry: string | null;
  street: string | null;
  address_extra: string | null;
  postal_code: string | null;
  city: string | null;
  country: string | null;
  contact_name: string | null;
  contact_role: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  contact_mobile: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  vat_id: string | null;
  tax_number: string | null;
  register_court: string | null;
  register_number: string | null;
  notes: string | null;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  created_at: string;
  details: TenantDetails;
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

// --- Automatisierungs-Check -------------------------------------------------

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

export interface LlmPluginConsumer {
  id: string;
  label: string;
  description: string;
  needsLlm: boolean;
}

export interface LlmPluginConsumersResponse {
  items: LlmPluginConsumer[];
}

export type LlmLogLevel = 'info' | 'warn' | 'error';

export interface LlmLogEntry {
  id: string;
  level: LlmLogLevel;
  action: string;
  providerId: string | null;
  providerName: string | null;
  message: string;
  createdAt: string;
}

export interface LlmLogListResponse {
  items: LlmLogEntry[];
  total: number;
  nextCursor: string | null;
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
  isDefault: boolean;
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
  isDefault?: boolean;
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

// --- Websites --------------------------------------------------------------

export type WebsiteStatus = 'draft' | 'live' | 'failed';
export type WebsiteBuildStatus = 'queued' | 'running' | 'ok' | 'failed' | 'cancelled';
export type WebsiteApprovalState = 'open' | 'approved' | 'changes' | 'expired';
export type WebsitePageOrigin = 'ai' | 'manual' | 'template';

export interface WebsiteClient {
  id: string;
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  created_at: string;
  updated_at: string;
}

export interface WebsiteBuild {
  id: string;
  site_id: string;
  trigger: string;
  status: WebsiteBuildStatus;
  duration_ms: number | null;
  error_file: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface WebsiteBuildSummary {
  id: string;
  status: WebsiteBuildStatus;
  created_at: string;
  duration_ms: number | null;
}

export interface WebsiteReleaseSummary {
  id: string;
  build_id: string;
  version: string;
  published_at: string;
}

export interface WebsiteOpenApproval {
  id: string;
  state: WebsiteApprovalState;
  expires_at: string;
  recipient: string | null;
}

export interface Website {
  id: string;
  client_id: string | null;
  name: string;
  slug: string;
  status: WebsiteStatus;
  astro_version: string;
  repo: string | null;
  branch: string | null;
  deploy_target: string | null;
  domain: string | null;
  domain_state: string;
  /** Internal port of the site listener; `null` until the delivery assigns one. */
  internal_port: number | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface WebsiteListItem extends Website {
  client_name: string | null;
  last_build: WebsiteBuildSummary | null;
  /** Address on the tailnet, or `null` when no port is assigned. */
  url: string | null;
}

export interface WebsiteDetail extends Website {
  client: WebsiteClient | null;
  pages_count: number;
  last_build: WebsiteBuildSummary | null;
  release: WebsiteReleaseSummary | null;
  open_approval: WebsiteOpenApproval | null;
  require_approval: boolean;
  url: string | null;
}

export interface WebsitePage {
  id: string;
  site_id: string;
  route: string;
  title: string;
  origin: WebsitePageOrigin;
  /** Markdown written for this route; `null` while only a title exists. */
  body_md: string | null;
  created_at: string;
  updated_at: string;
}

export interface WebsiteApproval {
  id: string;
  site_id: string;
  build_id: string;
  recipient: string | null;
  state: WebsiteApprovalState;
  comment: string | null;
  expires_at: string;
  decided_at: string | null;
  created_at: string;
}

export interface WebsiteApprovalLink extends WebsiteApproval {
  url: string;
  /** Built site with the approval token already appended, if the site has a port. */
  preview_url: string | null;
}

export interface WebsiteSummary {
  total: number;
  own: number;
  client: number;
  live: number;
  draft: number;
  failed: number;
  builds_running: number;
  approvals_open: number;
}

export interface WebsiteListResponse {
  items: WebsiteListItem[];
  total: number;
  nextCursor: string | null;
}

export interface WebsiteSettings {
  provider: 'anthropic' | 'openai' | 'local';
  model: string;
  max_tokens_per_run: number;
  max_cost_cents_per_run: number;
  monthly_budget_cents: number;
  require_approval: boolean;
  generate_images: boolean;
  updated_at: string;
}

export interface WebsiteAiJob {
  id: string;
  site_id: string;
  status: 'queued' | 'running' | 'ok' | 'failed' | 'cancelled';
  provider: string;
  model: string;
  brief: { goal: string; tone: string; pages: string[]; sources: string; max_tokens: number };
  created_at: string;
}

export interface PublicApproval {
  site: { name: string; domain: string | null; status: WebsiteStatus };
  build: { id: string; status: WebsiteBuildStatus; created_at: string } | null;
  state: WebsiteApprovalState;
  recipient: string | null;
  expires_at: string;
  pages: Array<{ route: string; title: string; origin: WebsitePageOrigin }>;
  comment: string | null;
}

export interface AgentSettings {
  providerId: string | null;
  modelId: string | null;
}

export interface AgentSourceInfo {
  id: string;
  label: string;
  description: string;
  href?: string;
}

export interface AgentStatus {
  configured: boolean;
  provider?: string | null;
  model: string | null;
  reachable: boolean;
  retentionDays: number;
  limits: { perMinute: number; perDay: number };
  sources: AgentSourceInfo[];
}

export interface AgentStep {
  seq: number;
  source: string;
  status: 'ok' | 'error';
  durationMs: number;
  errorCode?: string;
  truncated: boolean;
}

export interface AgentRun {
  id: string;
  question: string;
  answer: string | null;
  status: 'ok' | 'error';
  errorCode: string | null;
  model: string | null;
  durationMs: number | null;
  createdAt: string;
  finishedAt: string | null;
  steps: AgentStep[];
}

export interface AgentAskResponse {
  run: AgentRun;
  sources: AgentSourceInfo[];
  truncated: boolean;
}

export interface AgentRunListResponse {
  items: AgentRun[];
  total: number;
  nextCursor: string | null;
}

// --- Email plugin ----------------------------------------------------------

export type EmailTlsMode = 'starttls' | 'tls';
export type EmailDeliveryStatus = 'queued' | 'sending' | 'sent' | 'failed';

export interface EmailSender {
  name: string;
  address: string;
  reply_to: string | null;
}

export interface EmailTransportView {
  host: string;
  port: number;
  tls_mode: EmailTlsMode;
  username: string;
  password_set: boolean;
}

export interface EmailMailboxView extends EmailTransportView {
  address: string;
  configured: boolean;
}

export interface EmailRetentionView {
  days: number;
  min_days: number;
  max_days: number;
  presets: number[];
  scope: string;
  pending_rows: number;
  last_run_at: string | null;
  next_run_at: string;
}

export interface EmailSettings {
  status: 'configured' | 'unconfigured';
  sender: EmailSender;
  transport: EmailTransportView;
  mailbox: EmailMailboxView;
  retention: EmailRetentionView;
  updated_at: string | null;
}

export interface EmailSettingsInput {
  sender: { name: string; address: string; reply_to: string | null };
  transport: {
    host: string;
    port: number;
    tls_mode: EmailTlsMode;
    username: string;
    password?: string | null;
  };
  mailbox?: {
    host: string;
    port: number;
    tls_mode: EmailTlsMode;
    username: string;
    password?: string | null;
    address: string;
  };
  retention: { days: number };
  confirm_shortening?: boolean;
}

export interface EmailRetentionEffect {
  shortened: boolean;
  deleted: number;
  remaining: number;
}

export interface EmailSettingsSaved extends EmailSettings {
  retention_effect: EmailRetentionEffect;
}

export interface EmailOutboxItem {
  id: string;
  to_address: string | null;
  subject: string | null;
  status: EmailDeliveryStatus;
  attempts: number;
  created_at: string;
  sent_at: string | null;
  last_error_code: string | null;
  permanent_failure: boolean;
}

export interface EmailOutboxDetail extends EmailOutboxItem {
  text_body: string | null;
  html_body: string | null;
  reply_to: string | null;
  next_attempt_at: string;
  redacted_at: string | null;
}

export interface EmailInboxItem {
  id: string;
  from_address: string;
  from_name: string | null;
  subject: string;
  snippet: string;
  received_at: string;
  unread: boolean;
  attachment_count: number;
}

export interface EmailInboxDetail extends EmailInboxItem {
  message_id: string | null;
  text_body: string | null;
  html_body: string | null;
  retained_until: string;
}

export interface EmailListResponse<T> {
  items: T[];
  total: number;
  nextCursor: string | null;
}

export interface EmailInboxStatus {
  connected: boolean;
  address: string;
  last_sync_at: string | null;
  last_error_code: string | null;
  uid_validity: number | null;
  syncing: boolean;
  unread: number;
  stored: number;
}
