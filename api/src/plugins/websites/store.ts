import type { Db } from '../../kernel/db.ts';
import { notFound } from '../../kernel/errors.ts';
import { SLUG_PATTERN, slugFrom } from '../../kernel/ids.ts';

export type SiteStatus = 'draft' | 'live' | 'failed';
export type BuildStatus = 'queued' | 'running' | 'ok' | 'failed' | 'cancelled';
export type JobStatus = 'queued' | 'running' | 'ok' | 'failed' | 'cancelled';
export type ApprovalState = 'open' | 'approved' | 'changes' | 'expired';
export type PageOrigin = 'ai' | 'manual' | 'template';

export interface ClientRow {
  id: string;
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  created_at: string;
  updated_at: string;
}

export interface SiteRow {
  id: string;
  client_id: string | null;
  name: string;
  slug: string;
  status: SiteStatus;
  astro_version: string;
  repo: string | null;
  branch: string | null;
  deploy_target: string | null;
  domain: string | null;
  domain_state: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface PageRow {
  id: string;
  site_id: string;
  route: string;
  title: string;
  origin: PageOrigin;
  created_at: string;
  updated_at: string;
}

export interface BuildRow {
  id: string;
  site_id: string;
  trigger: string;
  status: BuildStatus;
  log: string | null;
  duration_ms: number | null;
  error_file: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface JobRow {
  id: string;
  site_id: string;
  brief_json: string;
  plan_json: string | null;
  provider: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cost_cents: number;
  status: JobStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApprovalRow {
  id: string;
  site_id: string;
  build_id: string;
  token_hash: string;
  recipient: string | null;
  state: ApprovalState;
  comment: string | null;
  expires_at: string;
  decided_at: string | null;
  created_at: string;
}

export interface ReleaseRow {
  id: string;
  site_id: string;
  build_id: string;
  version: string;
  published_by: string;
  published_at: string;
}

export interface SettingsRow {
  provider: string;
  model: string;
  max_tokens_per_run: number;
  max_cost_cents_per_run: number;
  monthly_budget_cents: number;
  require_approval: number;
  generate_images: number;
  updated_at: string;
}

/** A status change is only ever written through these values. */
export const SITE_STATUSES: readonly SiteStatus[] = ['draft', 'live', 'failed'];
export const BUILD_STATUSES: readonly BuildStatus[] = [
  'queued',
  'running',
  'ok',
  'failed',
  'cancelled',
];
export const APPROVAL_STATES: readonly ApprovalState[] = ['open', 'approved', 'changes', 'expired'];

export const MAX_ROUTE = 120;
export const MAX_NAME = 120;
export const ROUTE_PATTERN = /^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/;
export const DOMAIN_PATTERN =
  /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Builds and AI jobs share the same life cycle. */
export function isWorkActive(status: string): boolean {
  return status === 'queued' || status === 'running';
}

export function isSiteStatus(value: string): value is SiteStatus {
  return (SITE_STATUSES as readonly string[]).includes(value);
}

export function isApprovalState(value: string): value is ApprovalState {
  return (APPROVAL_STATES as readonly string[]).includes(value);
}

/** Slugs are unique inside one tenant database, so a clash gets a counter. */
export function uniqueSlug(db: Db, name: string, ignoredSiteId: string | null = null): string {
  const base = slugFrom(name) || 'website';
  let candidate = base;
  let counter = 2;
  while (true) {
    const row = db
      .prepare('select id from web_sites where slug = ? and id is not ?')
      .get(candidate, ignoredSiteId) as { id: string } | undefined;
    if (!row) return candidate;
    candidate = `${base}-${counter}`;
    counter += 1;
  }
}

export function validSlug(value: string): boolean {
  return SLUG_PATTERN.test(value) && value.length >= 2 && value.length <= 48;
}

export function findSite(db: Db, siteId: string): SiteRow | undefined {
  return db
    .prepare(
      `select id, client_id, name, slug, status, astro_version, repo, branch, deploy_target,
              domain, domain_state, created_by, created_at, updated_at
         from web_sites where id = ?`,
    )
    .get(siteId) as SiteRow | undefined;
}

/** Every route scoped by a site id goes through here: a foreign id is a 404. */
export function requireSite(db: Db, siteId: string): SiteRow {
  const row = findSite(db, siteId);
  if (!row) throw notFound('Website not found.');
  return row;
}

export function findBuild(db: Db, siteId: string, buildId: string): BuildRow | undefined {
  return db
    .prepare('select * from web_builds where id = ? and site_id = ?')
    .get(buildId, siteId) as BuildRow | undefined;
}

export function siteDetail(db: Db, site: SiteRow): Record<string, unknown> {
  const client = site.client_id
    ? (db
        .prepare('select id, name, contact_name, contact_email from web_clients where id = ?')
        .get(site.client_id) as Omit<ClientRow, 'created_at' | 'updated_at'> | undefined)
    : undefined;
  const pages = (
    db.prepare('select count(*) as count from web_site_pages where site_id = ?').get(site.id) as {
      count: number;
    }
  ).count;
  const lastBuild = db
    .prepare(
      `select id, status, created_at, duration_ms from web_builds
        where site_id = ? order by created_at desc, id desc limit 1`,
    )
    .get(site.id) as Pick<BuildRow, 'id' | 'status' | 'created_at' | 'duration_ms'> | undefined;
  const release = db
    .prepare(
      `select id, build_id, version, published_at from web_releases
        where site_id = ? order by published_at desc, id desc limit 1`,
    )
    .get(site.id) as Pick<ReleaseRow, 'id' | 'build_id' | 'version' | 'published_at'> | undefined;
  const approval = db
    .prepare(
      `select id, state, expires_at, recipient from web_approvals
        where site_id = ? and state = 'open' order by created_at desc, id desc limit 1`,
    )
    .get(site.id) as Pick<ApprovalRow, 'id' | 'state' | 'expires_at' | 'recipient'> | undefined;

  const settings = db.prepare('select require_approval from web_settings where id = 1').get() as
    { require_approval: number } | undefined;

  return {
    ...site,
    client: client ?? null,
    pages_count: pages,
    last_build: lastBuild ?? null,
    release: release ?? null,
    open_approval: approval ?? null,
    require_approval: settings ? settings.require_approval === 1 : true,
  };
}
