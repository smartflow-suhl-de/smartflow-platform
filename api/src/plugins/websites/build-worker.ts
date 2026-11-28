import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../../kernel/db.ts';
import type { BuildRow, JobRow, SiteRow } from './store.ts';
import type { Runtime } from './runtime.ts';

/** Site builds, artifact retention and the process that runs one Astro build. */
export interface SiteBuilds {
  /** Starts work if the queue is not empty; safe to call on every request. */
  kick(): void;
  /** Kills a running child; the row is already `cancelled` when this returns. */
  cancel(buildId: string): boolean;
  /** Stops the worker and its children. */
  close(): Promise<void>;
  /** Artifact directory of a finished build, if the files are still there. */
  artifactDir(tenantId: string, buildId: string): string | null;
  /** Total size and file count of an artifact directory. */
  artifactStats(tenantId: string, buildId: string): ArtifactStats | null;
}

export interface ArtifactStats {
  files: number;
  bytes: number;
  hash: string;
}

const LOG_LIMIT = 20_000;

/**
 * The build runs as a child of the API process, not in its own container. That
 * is only safe because it never runs code from a customer repository: the input
 * is this repository's template plus Markdown. The permission model still draws
 * a line around the tenant databases, which is where an accident would hurt
 * most.
 */
export function createSiteBuilds(runtime: Runtime): SiteBuilds {
  const { log } = runtime;
  const buildsRoot = join(runtime.config.dataDir, 'builds');
  const templateDir = runtime.templateDir;
  const timeoutMs = runtime.buildTimeoutMs;
  const keepPerSite = runtime.buildKeepPerSite;
  const children = new Map<string, ChildProcess>();
  let running = false;
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  // Tests build apps in-process; they must not sweep real data or spawn builds.
  const enabled = runtime.ctx.config.env !== 'test' && process.env.SF_BUILD_WORKER !== '0';

  /**
   * `tsconfck` walks up from the build directory to `/` looking for a
   * `tsconfig.json`, and the permission model turns every unreadable `stat`
   * into a hard error. A file at the root of the builds tree makes the walk stop
   * before it reaches the data volume, so the read allowlist stays narrow.
   */
  function prepareRoot(): void {
    mkdirSync(buildsRoot, { recursive: true, mode: 0o700 });
    // `tsconfck` walks up from every file it inspects and stops at the first
    // `tsconfig.json` or `jsconfig.json`. Both must exist here, otherwise the
    // walk continues past the builds root and the read allowlist refuses it.
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const sentinel = join(buildsRoot, name);
      if (!existsSync(sentinel)) writeFileSync(sentinel, '{}\n', { mode: 0o600 });
    }
    // Dependencies live under the builds root, not next to the template: tools
    // resolve a module's real path and then walk upward for a `tsconfig.json`,
    // and every step of that walk must stay inside the read allowlist.
    const deps = join(buildsRoot, 'node_modules');
    if (!existsSync(join(deps, 'astro'))) {
      rmSync(deps, { recursive: true, force: true });
      cpSync(join(templateDir, 'node_modules'), deps, { recursive: true });
      writeFileSync(join(deps, 'tsconfig.json'), '{}\n', { mode: 0o600 });
    }
  }

  function sitePath(tenantId: string, buildId: string): string {
    return join(buildsRoot, tenantId, buildId);
  }

  /** Old builds of a site go first; the release and an open approval are kept. */
  function applyRetention(database: Db, siteId: string): void {
    const protectedIds = new Set(
      (
        database
          .prepare('select build_id from web_releases where site_id = ?')
          .all(siteId) as Array<{ build_id: string }>
      ).map((row) => row.build_id),
    );
    // A link that is still under review must keep working after a rebuild.
    for (const row of database
      .prepare(
        `select build_id from web_approvals
          where site_id = ? and state in ('open','approved')`,
      )
      .all(siteId) as Array<{ build_id: string }>) {
      protectedIds.add(row.build_id);
    }
    const builds = database
      .prepare(
        `select id from web_builds where site_id = ? and status = 'ok'
          order by created_at desc, id desc`,
      )
      .all(siteId) as Array<{ id: string }>;
    let kept = 0;
    for (const build of builds) {
      if (protectedIds.has(build.id)) continue;
      kept += 1;
      if (kept <= keepPerSite) continue;
      const row = database
        .prepare('select artifact_dir from web_build_artifacts where build_id = ?')
        .get(build.id) as { artifact_dir: string } | undefined;
      if (row) {
        rmSync(row.artifact_dir, { recursive: true, force: true });
        database.prepare('delete from web_build_artifacts where build_id = ?').run(build.id);
      }
    }
  }

  /** Builds that were running when the process died would hang forever. */
  function sweep(database: Db): void {
    const timestamp = runtime.now().toISOString();
    database
      .prepare(
        `update web_builds set status = 'failed', finished_at = ?,
                log = coalesce(log || char(10), '') || 'Der Buildprozess wurde beendet.'
          where status = 'running'`,
      )
      .run(timestamp);
    database
      .prepare(
        `update web_ai_jobs set status = 'failed',
                error = coalesce(error, 'Der KI-Lauf wurde beendet.'), updated_at = ?
          where status = 'running'`,
      )
      .run(timestamp);
  }

  function findQueued(): { tenantId: string; build: BuildRow } | null {
    for (const tenant of runtime.ctx.tenants()) {
      const database = runtime.tenantDb(tenant.id);
      const build = database
        .prepare(
          `select * from web_builds where status = 'queued'
            order by created_at asc, id asc limit 1`,
        )
        .get() as BuildRow | undefined;
      if (build) return { tenantId: tenant.id, build };
    }
    return null;
  }

  function findQueuedJob(): { tenantId: string; job: JobRow } | null {
    for (const tenant of runtime.ctx.tenants()) {
      const database = runtime.tenantDb(tenant.id);
      const job = database
        .prepare(
          `select * from web_ai_jobs where status = 'queued'
            order by created_at asc, id asc limit 1`,
        )
        .get() as JobRow | undefined;
      if (job) return { tenantId: tenant.id, job };
    }
    return null;
  }

  function markRunning(database: Db, build: BuildRow): boolean {
    // The status predicate makes two workers (or a cancel in between) resolve to
    // exactly one winner instead of both writing `running`.
    const claimed = database
      .prepare(
        `update web_builds set status = 'running', started_at = ?
          where id = ? and status = 'queued'`,
      )
      .run(runtime.now().toISOString(), build.id);
    return claimed.changes === 1;
  }

  function finish(
    tenantId: string,
    database: Db,
    build: BuildRow,
    outcome: {
      status: 'ok' | 'failed';
      log: string;
      durationMs: number;
      errorFile?: string | null;
    },
  ): void {
    const timestamp = runtime.now().toISOString();
    database
      .prepare(
        `update web_builds set status = ?, log = ?, duration_ms = ?, error_file = ?,
                finished_at = ?
          where id = ? and status = 'running'`,
      )
      .run(
        outcome.status,
        outcome.log.slice(0, LOG_LIMIT),
        outcome.durationMs,
        outcome.errorFile ?? null,
        timestamp,
        build.id,
      );
    const released = database
      .prepare('select id from web_releases where site_id = ? limit 1')
      .get(build.site_id) as { id: string } | undefined;
    database
      .prepare('update web_sites set status = ?, updated_at = ? where id = ?')
      .run(
        outcome.status === 'ok' ? (released ? 'live' : 'draft') : 'failed',
        timestamp,
        build.site_id,
      );
    if (outcome.status === 'ok') applyRetention(database, build.site_id);
    runtime.onBuildSettled?.(tenantId, build.site_id);
  }

  /** Markdown per route: the plan carries titles, the brief carries the text. */
  function writeContent(target: string, site: SiteRow, database: Db): void {
    const pagesDir = join(target, 'content', 'pages');
    rmSync(pagesDir, { recursive: true, force: true });
    mkdirSync(pagesDir, { recursive: true, mode: 0o700 });

    const pages = database
      .prepare(
        'select route, title, body_md from web_site_pages where site_id = ? order by route, id',
      )
      .all(site.id) as Array<{ route: string; title: string; body_md: string | null }>;
    const job = database
      .prepare(
        `select brief_json, plan_json from web_ai_jobs
          where site_id = ? and status = 'ok' order by created_at desc limit 1`,
      )
      .get(site.id) as Pick<JobRow, 'brief_json' | 'plan_json'> | undefined;
    const brief = job ? (JSON.parse(job.brief_json) as { goal?: string }) : {};
    const plan = job?.plan_json ? (JSON.parse(job.plan_json) as { summary?: string }) : {};
    const paragraph = [plan.summary, brief.goal]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .find((value) => value.length > 0);
    const body = paragraph ?? 'Diese Seite wird noch mit Inhalten gefüllt.';
    // The AI writes Markdown per page; the brief is only the fallback for a
    // route that was added by hand and has no text yet.
    const bodyOf = (page: { body_md: string | null }): string => {
      const text = (page.body_md ?? '').trim();
      return text.length > 0 ? text : body;
    };

    // Frontmatter is written by hand, so quotes and newlines are neutralised:
    // a title comes from the model and may contain either.
    const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

    if (pages.length === 0) {
      writeFileSync(
        join(pagesDir, 'index.md'),
        `---\ntitle: ${quote(site.name)}\norder: 0\n---\n\n${body}\n`,
        { mode: 0o600 },
      );
    }
    pages.forEach((page, index) => {
      const segments = page.route.split('/').filter(Boolean);
      const file =
        segments.length === 0 ? join(pagesDir, 'index.md') : join(pagesDir, ...segments) + '.md';
      mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
      writeFileSync(
        file,
        `---\ntitle: ${quote(page.title)}\norder: ${index + 1}\n---\n\n${bodyOf(page)}\n`,
        { mode: 0o600 },
      );
    });
    writeFileSync(
      join(target, 'content', 'site.json'),
      `${JSON.stringify({ name: site.name, tagline: body }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  function prepareSource(tenantId: string, build: BuildRow, site: SiteRow, database: Db): string {
    const root = sitePath(tenantId, build.id);
    const source = join(root, 'src');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(source, { recursive: true, mode: 0o700 });
    for (const entry of readdirSync(templateDir)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.astro') continue;
      cpSync(join(templateDir, entry), join(source, entry), { recursive: true });
    }
    // The image carries the template's dependencies; the build never runs
    // `npm ci`, so it needs no registry and no network.
    symlinkSync(join(buildsRoot, 'node_modules'), join(source, 'node_modules'), 'dir');
    writeContent(source, site, database);
    mkdirSync(join(root, 'tmp'), { recursive: true, mode: 0o700 });
    return source;
  }

  function runBuild(tenantId: string, database: Db, build: BuildRow): Promise<void> {
    return new Promise((resolve) => {
      const site = database
        .prepare('select * from web_sites where id = ?')
        .get(build.site_id) as SiteRow;
      const started = Date.now();
      let source: string;
      try {
        source = prepareSource(tenantId, build, site, database);
      } catch (error) {
        finish(tenantId, database, build, {
          status: 'failed',
          log: `Vorbereitung fehlgeschlagen: ${(error as Error).message}`,
          durationMs: 0,
        });
        resolve();
        return;
      }

      const root = sitePath(tenantId, build.id);
      const astro = join(buildsRoot, 'node_modules', 'astro', 'astro.js');
      const args = [
        '--permission',
        `--allow-fs-read=${buildsRoot}`,
        `--allow-fs-read=/run`,
        '--allow-fs-read=/proc/version',
        '--allow-fs-read=/proc/sys/fs/binfmt_misc',
        `--allow-fs-write=${root}`,
        // Vite and esbuild start helpers, and Rollup loads its native parser.
        // Neither reaches outside the read allowlist, so the line that matters —
        // the tenant databases — is still closed.
        '--allow-child-process',
        '--allow-worker',
        '--allow-addons',
        '--max-old-space-size=512',
        astro,
        'build',
        '--no-telemetry',
      ];
      let child: ChildProcess;
      try {
        child = spawn(process.execPath, args, {
          cwd: source,
          env: {
            PATH: '/usr/local/bin:/usr/bin:/bin',
            HOME: root,
            TMPDIR: join(root, 'tmp'),
            NODE_ENV: 'production',
            ASTRO_TELEMETRY_DISABLED: '1',
            SF_SITE_CACHE: join(root, 'vite-cache'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        finish(tenantId, database, build, {
          status: 'failed',
          log: `Start fehlgeschlagen: ${(error as Error).message}`,
          durationMs: Date.now() - started,
        });
        resolve();
        return;
      }

      children.set(build.id, child);
      const chunks: string[] = [];
      let size = 0;
      const collect = (chunk: Buffer) => {
        if (size >= LOG_LIMIT * 2) return;
        const text = chunk.toString('utf8');
        size += text.length;
        chunks.push(text);
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);

      let timedOut = false;
      const limit = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      const settle = (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(limit);
        children.delete(build.id);
        const durationMs = Date.now() - started;
        const output = chunks.join('').slice(-LOG_LIMIT);
        const cancelled =
          (
            database.prepare('select status from web_builds where id = ?').get(build.id) as
              { status: string } | undefined
          )?.status === 'cancelled';
        if (cancelled) {
          // Cancel already wrote the row; only the files are left to clear.
          rmSync(root, { recursive: true, force: true });
          resolve();
          return;
        }
        if (code === 0 && !timedOut) {
          const dist = join(source, 'dist');
          const artifact = join(root, 'dist');
          let stats: ArtifactStats | null = null;
          let errorFile: string | null = null;
          // Astro reports success for an empty project; a site without a home
          // page is not a site, so the artifact must carry `index.html`.
          if (existsSync(join(dist, 'index.html'))) {
            renameSync(dist, artifact);
            stats = measure(artifact);
            database
              .prepare(
                `insert into web_build_artifacts
                   (build_id, site_id, artifact_dir, files, bytes, hash, created_at)
                 values (?, ?, ?, ?, ?, ?, ?)
                 on conflict(build_id) do update set files = excluded.files,
                   bytes = excluded.bytes, hash = excluded.hash`,
              )
              .run(
                build.id,
                build.site_id,
                artifact,
                stats.files,
                stats.bytes,
                stats.hash,
                runtime.now().toISOString(),
              );
          } else {
            errorFile = 'index.html fehlt nach dem Build';
          }
          finish(tenantId, database, build, {
            status: stats ? 'ok' : 'failed',
            log: output,
            durationMs,
            errorFile,
          });
          // The source copy is dead weight once the artifact exists.
          rmSync(source, { recursive: true, force: true });
        } else {
          const reason = timedOut
            ? `Zeitlimit von ${Math.round(timeoutMs / 1000)} s überschritten.`
            : signal
              ? `Build abgebrochen (${signal}).`
              : `Build fehlgeschlagen (Code ${code}).`;
          finish(tenantId, database, build, {
            status: 'failed',
            log: `${reason}\n${output}`.slice(0, LOG_LIMIT),
            durationMs,
          });
          rmSync(source, { recursive: true, force: true });
        }
        resolve();
      };

      child.on('error', () => settle(null, null));
      child.on('close', (code, signal) => settle(code, signal));
    });
  }

  async function drain(): Promise<void> {
    if (running || closed) return;
    running = true;
    try {
      // Builds first: a build is what a person is waiting for.
      for (;;) {
        if (closed) break;
        const next = findQueued();
        if (!next) break;
        const database = runtime.tenantDb(next.tenantId);
        if (!markRunning(database, next.build)) continue;
        await runBuild(next.tenantId, database, next.build);
      }
      for (;;) {
        if (closed) break;
        const nextJob = findQueuedJob();
        if (!nextJob) break;
        await runtime.runJob(nextJob.tenantId, nextJob.job);
      }
    } catch (error) {
      log.error({ err: error }, 'site build worker failed');
    } finally {
      running = false;
    }
    if (!closed) {
      const pending = findQueued() !== null || findQueuedJob() !== null;
      if (pending) schedule(250);
    }
  }

  function schedule(delayMs: number): void {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void drain();
    }, delayMs);
    timer.unref();
  }

  function kick(): void {
    if (!enabled || running || closed) return;
    schedule(0);
  }

  function cancel(buildId: string): boolean {
    const child = children.get(buildId);
    if (!child) return false;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 3_000).unref();
    return true;
  }

  function artifactDir(tenantId: string, buildId: string): string | null {
    const database = runtime.tenantDb(tenantId);
    const row = database
      .prepare('select artifact_dir from web_build_artifacts where build_id = ?')
      .get(buildId) as { artifact_dir: string } | undefined;
    if (!row) return null;
    return existsSync(join(row.artifact_dir, 'index.html')) ? row.artifact_dir : null;
  }

  function artifactStats(tenantId: string, buildId: string): ArtifactStats | null {
    const dir = artifactDir(tenantId, buildId);
    if (!dir) return null;
    try {
      return measure(dir);
    } catch {
      return null;
    }
  }

  if (enabled) prepareRoot();
  if (enabled) {
    for (const tenant of runtime.ctx.tenants()) {
      try {
        sweep(runtime.tenantDb(tenant.id));
      } catch (error) {
        log.error({ err: error, tenantId: tenant.id }, 'build sweep failed');
      }
    }
    schedule(1_000);
  }

  return {
    kick,
    cancel,
    artifactDir,
    artifactStats,
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      for (const child of children.values()) child.kill('SIGKILL');
      children.clear();
    },
  };
}

/** Files, bytes and a stable digest of the artifact, used to prove a release. */
export function measure(root: string): ArtifactStats {
  let files = 0;
  let bytes = 0;
  const hash = createHash('sha256');
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(dir, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full, relative);
        continue;
      }
      if (!entry.isFile()) continue;
      files += 1;
      const info = statSync(full);
      bytes += info.size;
      hash.update(relative);
      hash.update(readFileSync(full));
    }
  };
  walk(root, '');
  return { files, bytes, hash: hash.digest('hex') };
}
