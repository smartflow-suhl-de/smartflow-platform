import type { PluginContext } from '../../kernel/context.ts';
import { manifest } from './manifest.ts';
import { createRuntime } from './runtime.ts';
import { registerSites } from './sites.ts';
import { registerPipeline } from './pipeline.ts';
import { registerApprovals } from './approvals.ts';

/**
 * `websites` keeps the agency's portfolio in its own tenant database. The
 * routes are split by concern: the portfolio itself, the build/AI pipeline and
 * the approval/release side. All three share one runtime, so tenant access and
 * settings stay in a single place.
 */
export function register(ctx: PluginContext): void {
  ctx.migrateTenant([
    {
      version: 1,
      up(database) {
        database.exec(`
          create table web_clients (
            id text primary key,
            name text not null,
            contact_name text,
            contact_email text,
            created_at text not null,
            updated_at text not null
          );

          create table web_sites (
            id text primary key,
            client_id text references web_clients(id) on delete set null,
            name text not null,
            slug text not null,
            status text not null check (status in ('draft','live','failed')),
            astro_version text not null default '5',
            repo text,
            branch text,
            deploy_target text,
            domain text,
            domain_state text not null default 'unchecked',
            created_by text not null,
            created_at text not null,
            updated_at text not null
          );
          create unique index web_sites_slug on web_sites(slug);
          create index web_sites_created on web_sites(created_at, id);
          create index web_sites_status on web_sites(status);
          create index web_sites_client on web_sites(client_id);

          create table web_site_pages (
            id text primary key,
            site_id text not null references web_sites(id) on delete cascade,
            route text not null,
            title text not null,
            origin text not null check (origin in ('ai','manual','template')),
            created_at text not null,
            updated_at text not null
          );
          create unique index web_pages_route on web_site_pages(site_id, route);

          create table web_builds (
            id text primary key,
            site_id text not null references web_sites(id) on delete cascade,
            trigger text not null,
            status text not null check (status in ('queued','running','ok','failed','cancelled')),
            log text,
            duration_ms integer,
            error_file text,
            created_at text not null,
            started_at text,
            finished_at text
          );
          create index web_builds_site on web_builds(site_id, created_at, id);

          create table web_ai_jobs (
            id text primary key,
            site_id text not null references web_sites(id) on delete cascade,
            brief_json text not null,
            plan_json text,
            provider text not null,
            model text not null,
            tokens_in integer not null default 0,
            tokens_out integer not null default 0,
            cost_cents integer not null default 0,
            status text not null check (status in ('queued','running','ok','failed','cancelled')),
            error text,
            created_at text not null,
            updated_at text not null
          );
          create index web_ai_jobs_site on web_ai_jobs(site_id, created_at, id);
          create index web_ai_jobs_created on web_ai_jobs(created_at);

          create table web_approvals (
            id text primary key,
            site_id text not null references web_sites(id) on delete cascade,
            build_id text not null references web_builds(id) on delete cascade,
            token_hash text not null,
            recipient text,
            state text not null check (state in ('open','approved','changes','expired')),
            comment text,
            expires_at text not null,
            decided_at text,
            created_at text not null
          );
          create unique index web_approvals_token on web_approvals(token_hash);
          create index web_approvals_site on web_approvals(site_id, created_at, id);

          create table web_releases (
            id text primary key,
            site_id text not null references web_sites(id) on delete cascade,
            build_id text not null references web_builds(id) on delete cascade,
            version text not null,
            published_by text not null,
            published_at text not null
          );
          create unique index web_releases_build on web_releases(build_id);

          create table web_settings (
            id integer primary key check (id = 1),
            provider text not null default 'anthropic',
            model text not null default 'standard',
            max_tokens_per_run integer not null default 25000,
            max_cost_cents_per_run integer not null default 100,
            monthly_budget_cents integer not null default 15000,
            require_approval integer not null default 1,
            generate_images integer not null default 0,
            updated_at text not null
          );
        `);
      },
    },
  ]);

  const runtime = createRuntime(ctx);
  registerSites(runtime);
  registerPipeline(runtime);
  registerApprovals(runtime);
}

export default { manifest, register };
