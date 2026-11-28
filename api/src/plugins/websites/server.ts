import { newId } from '../../kernel/ids.ts';
import type { PluginContext } from '../../kernel/context.ts';
import { manifest } from './manifest.ts';
import { createRuntime } from './runtime.ts';
import { registerSites } from './sites.ts';
import { registerPipeline } from './pipeline.ts';
import { registerApprovals } from './approvals.ts';
import { registerPreviews } from './previews.ts';
import { createSiteBuilds } from './build-worker.ts';
import { createAiWorker } from './ai-worker.ts';
import { createDelivery } from './delivery.ts';
import type { SiteRow } from './store.ts';

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
    {
      version: 2,
      up(database) {
        // Delivery is a port per site, not a path prefix: the build keeps
        // `base: "/"` and a site cannot reach the panel's session cookie.
        database.exec(`
          alter table web_sites add column internal_port integer;
          create unique index web_sites_port on web_sites(internal_port)
            where internal_port is not null;

          alter table web_site_pages add column body_md text;

          create table web_build_artifacts (
            build_id text primary key references web_builds(id) on delete cascade,
            site_id text not null references web_sites(id) on delete cascade,
            artifact_dir text not null,
            files integer not null default 0,
            bytes integer not null default 0,
            hash text not null,
            created_at text not null
          );
          create index web_build_artifacts_site on web_build_artifacts(site_id);
        `);
      },
    },
    {
      version: 3,
      up(database) {
        // `deploy_target` started as free text without any effect. It now
        // decides whether a site is published to the tailnet, so every old row
        // is moved to the values the delivery understands.
        database.exec(`
          update web_sites set deploy_target = 'static'
            where deploy_target in ('static', 'internal', 'local');
          update web_sites set deploy_target = 'tailscale'
            where deploy_target is null or deploy_target not in ('static', 'tailscale');
        `);
      },
    },
    {
      version: 4,
      up(database) {
        // Staff previews are their own rows: they must not appear as open
        // approvals and must not be able to satisfy the publish gate.
        database.exec(`
          create table web_previews (
            id text primary key,
            site_id text not null references web_sites(id) on delete cascade,
            build_id text not null references web_builds(id) on delete cascade,
            token_hash text not null,
            created_by text not null,
            expires_at text not null,
            created_at text not null
          );
          create unique index web_previews_token on web_previews(token_hash);
          create index web_previews_site on web_previews(site_id, created_at, id);
        `);
      },
    },
  ]);

  const runtime = createRuntime(ctx);
  const aiWorker = createAiWorker(runtime);
  runtime.runJob = (tenantId, job) => aiWorker.run(tenantId, job);
  const builds = createSiteBuilds(runtime);
  const delivery = createDelivery(runtime, builds);

  registerSites(runtime, delivery);
  registerPipeline(runtime, builds);
  registerApprovals(runtime, delivery);
  registerPreviews(runtime, delivery);

  // A finished AI job leaves pages behind that nobody has built yet. Queueing
  // the build here is what turns a plan into a preview a client can open.
  runtime.onJobSettled = (tenantId, siteId) => {
    const database = runtime.tenantDb(tenantId);
    const active = database
      .prepare("select id from web_builds where site_id = ? and status in ('queued','running')")
      .get(siteId) as { id: string } | undefined;
    if (active) return;
    database
      .prepare(
        `insert into web_builds (id, site_id, trigger, status, created_at)
         values (?, ?, 'ai', 'queued', ?)`,
      )
      .run(newId('bld'), siteId, runtime.now().toISOString());
    builds.kick();
  };
  // A site that was just published or had its target changed needs its listener
  // on the right interface; a build alone does not move it.
  runtime.onBuildSettled = (tenantId, siteId) => {
    const database = runtime.tenantDb(tenantId);
    const site = database.prepare('select * from web_sites where id = ?').get(siteId) as
      SiteRow | undefined;
    if (site) delivery.ensure(tenantId, site);
  };

  // Listeners first, then the queue: a build that was queued before the restart
  // must not wait for the next request to be picked up.
  delivery.start();
  builds.kick();

  runtime.app.addHook('onClose', async () => {
    await builds.close();
    await delivery.stopAll();
  });
}

export default { manifest, register };
