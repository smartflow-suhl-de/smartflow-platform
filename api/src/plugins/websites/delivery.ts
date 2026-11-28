import { createServer, type Server } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { hashToken } from '../../kernel/crypto.ts';
import type { Db } from '../../kernel/db.ts';
import { deployTargetOf, type SiteRow } from './store.ts';
import type { SiteBuilds } from './build-worker.ts';
import type { Runtime } from './runtime.ts';

/**
 * Every website gets its own internal port and therefore its own origin: the
 * Astro build can keep `base: "/"`, and generated HTML cannot reach the API
 * session because a different port is a different origin.
 *
 * The ports are not published on the host. `tailscale serve` maps each one to a
 * port on the tailnet node, which is the only way in.
 */
export interface Delivery {
  /** Starts a listener for every site that already has a port. */
  start(): void;
  /** Assigns a port if needed and starts the listener. */
  ensure(tenantId: string, site: SiteRow): SiteRow;
  stop(siteId: string): void;
  stopAll(): Promise<void>;
  /** The address a person opens, or `null` while the site has no port. */
  publicUrl(site: SiteRow): string | null;
  /** Smallest free port of the configured range, or `null` when it is full. */
  allocatePort(database: Db, siteId: string): number | null;
}

const PREVIEW_COOKIE = 'sf_preview';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json; charset=utf-8',
};

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'cross-origin-opener-policy': 'same-origin',
  // Customer HTML is untrusted by default: it may use its own files and inline
  // styles, but it may not load scripts from anywhere else or frame us.
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; font-src 'self'; connect-src 'self'; form-action 'none'; " +
    "frame-ancestors 'none'; base-uri 'self'",
};

interface Listener {
  server: Server;
  port: number;
  host: string;
  tenantId: string;
  siteId: string;
}

export function createDelivery(runtime: Runtime, builds: SiteBuilds): Delivery {
  const listeners = new Map<string, Listener>();
  const sites = runtime.sites;
  const origin = safeOrigin(runtime.config.publicUrl);

  function safeOrigin(url: string): { host: string; secure: boolean } | null {
    try {
      const parsed = new URL(url);
      return { host: parsed.hostname, secure: parsed.protocol === 'https:' };
    } catch {
      return null;
    }
  }

  function portFor(site: SiteRow): number | null {
    if (!sites.enabled) return null;
    const port = site.internal_port;
    if (port === null || port < sites.portBase || port >= sites.portBase + sites.portCount) {
      return null;
    }
    return port;
  }

  function publicUrl(site: SiteRow): string | null {
    const port = portFor(site);
    if (port === null || origin === null) return null;
    // A `static` site is served by this process only; advertising a tailnet
    // address for it would promise a reachability the binding refuses.
    if (deployTargetOf(site) === 'static') return null;
    return `${origin.secure ? 'https' : 'http'}://${origin.host}:${
      sites.tailnetPortBase + (port - sites.portBase)
    }/`;
  }

  /**
   * `tailscale` binds the site port on the container interface, where the
   * `tailscale serve` proxy reaches it. `static` binds loopback only, so the
   * tailnet mapping ends in a refused connection instead of a private page.
   */
  function hostFor(site: SiteRow): string {
    return deployTargetOf(site) === 'static' ? '127.0.0.1' : sites.host;
  }

  function allocatePort(database: Db, siteId: string): number | null {
    if (!sites.enabled) return null;
    // One port range for the whole platform: every site in every database
    // claims a port, so two tenants can never be handed the same one.
    const used = new Set<number>();
    for (const tenant of runtime.ctx.tenants()) {
      const rows = runtime
        .tenantDb(tenant.id)
        .prepare('select internal_port from web_sites where internal_port is not null')
        .all() as Array<{ internal_port: number }>;
      for (const row of rows) used.add(row.internal_port);
    }
    for (let index = 0; index < sites.portCount; index += 1) {
      const candidate = sites.portBase + index;
      if (!used.has(candidate)) {
        database
          .prepare('update web_sites set internal_port = ?, updated_at = ? where id = ?')
          .run(candidate, runtime.now().toISOString(), siteId);
        return candidate;
      }
    }
    return null;
  }

  /** The build a token in the URL opens: an approval link or a staff preview. */
  function tokenGrant(
    database: Db,
    siteId: string,
    plaintext: string,
  ): { build_id: string; expires_at: string } | null {
    const hashed = hashToken(plaintext);
    const nowMs = runtime.now().getTime();
    const approval = database
      .prepare(
        `select build_id, expires_at, state from web_approvals where token_hash = ? and site_id = ?`,
      )
      .get(hashed, siteId) as { build_id: string; expires_at: string; state: string } | undefined;
    if (
      approval &&
      (approval.state === 'open' || approval.state === 'approved') &&
      Date.parse(approval.expires_at) >= nowMs
    ) {
      return { build_id: approval.build_id, expires_at: approval.expires_at };
    }
    const preview = database
      .prepare(
        `select build_id, expires_at from web_previews
          where token_hash = ? and site_id = ? and expires_at >= ?`,
      )
      .get(hashed, siteId, runtime.now().toISOString()) as
      { build_id: string; expires_at: string } | undefined;
    return preview ?? null;
  }

  /** The build a visitor sees: the preview from the cookie, else the release. */
  function buildFor(tenantId: string, site: SiteRow, cookieToken: string | null): string | null {
    const database = runtime.tenantDb(tenantId);
    if (cookieToken !== null && cookieToken.length >= 16) {
      const grant = tokenGrant(database, site.id, cookieToken);
      if (grant) return grant.build_id;
    }
    const release = database
      .prepare(
        `select build_id from web_releases
          where site_id = ? order by published_at desc, id desc limit 1`,
      )
      .get(site.id) as { build_id: string } | undefined;
    return release?.build_id ?? null;
  }

  function send(
    response: import('node:http').ServerResponse,
    status: number,
    body: string,
    headers: Record<string, string>,
  ): void {
    response.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
      ...SECURITY_HEADERS,
      ...headers,
    });
    response.end(body);
  }

  function page(title: string, text: string): string {
    return `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title>
<style>html{font-family:system-ui,sans-serif;background:#f2efe7;color:#12161a}
body{margin:0;min-height:100vh;display:grid;place-items:center}
main{max-width:34rem;padding:2rem}code{font-family:ui-monospace,monospace;font-size:.85em}</style>
</head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
  }

  function resolveFile(root: string, pathname: string): string | null {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (decoded.includes('\0') || decoded.includes('\\')) return null;
    const relative = decoded.replace(/^\/+/, '');
    let target = resolve(root, relative);
    if (target !== root && !target.startsWith(root + sep)) return null;
    try {
      if (statSync(target).isDirectory()) target = join(target, 'index.html');
      if (!statSync(target).isFile()) return null;
    } catch {
      return null;
    }
    return target;
  }

  function handle(
    tenantId: string,
    siteId: string,
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ): void {
    try {
      const database = runtime.tenantDb(tenantId);
      const site = database.prepare('select * from web_sites where id = ?').get(siteId) as
        SiteRow | undefined;
      if (!site) {
        send(response, 404, page('Nicht gefunden', 'Diese Website existiert nicht mehr.'), {
          'cache-control': 'no-store',
        });
        return;
      }

      const url = new URL(request.url ?? '/', 'http://site.invalid');
      const token = url.searchParams.get('t');
      let previewToken = readCookie(request.headers.cookie, PREVIEW_COOKIE);

      if (token !== null && token.length >= 16) {
        const grant = tokenGrant(database, site.id, token);
        if (grant) {
          const maxAge = Math.max(
            0,
            Math.floor((Date.parse(grant.expires_at) - runtime.now().getTime()) / 1000),
          );
          const secure = origin?.secure ? '; Secure' : '';
          response.setHeader(
            'set-cookie',
            `${PREVIEW_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`,
          );
          previewToken = token;
          url.searchParams.delete('t');
          response.writeHead(303, {
            location: `${url.pathname}${url.search}`,
            ...SECURITY_HEADERS,
            'cache-control': 'no-store',
          });
          response.end();
          return;
        }
      }

      const buildId = buildFor(tenantId, site, previewToken);
      if (buildId === null) {
        send(
          response,
          404,
          page(
            'Noch nicht veröffentlicht',
            'Diese Website hat noch keinen veröffentlichten Stand. Öffnen Sie im Panel die interne Vorschau oder den Freigabe-Link.',
          ),
          { 'cache-control': 'no-store' },
        );
        return;
      }
      const root = builds.artifactDir(tenantId, buildId);
      if (root === null) {
        send(response, 404, page('Stand nicht verfügbar', 'Der Build liegt nicht mehr vor.'), {
          'cache-control': 'no-store',
        });
        return;
      }

      const file = resolveFile(root, url.pathname);
      if (file === null) {
        send(response, 404, page('Nicht gefunden', 'Diese Seite gibt es nicht.'), {
          'cache-control': 'no-store',
        });
        return;
      }

      const body = readFileSync(file);
      const extension = extname(file).toLowerCase();
      const isHtml = extension === '.html';
      const isPreview = previewToken !== null;
      const immutable = url.pathname.startsWith('/_astro/') && !isPreview;
      response.writeHead(200, {
        'content-type': MIME[extension] ?? 'application/octet-stream',
        'content-length': String(body.byteLength),
        ...SECURITY_HEADERS,
        'cache-control': isPreview
          ? 'no-store'
          : immutable
            ? 'public, max-age=31536000, immutable'
            : isHtml
              ? 'no-cache'
              : 'public, max-age=3600',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      runtime.log.error({ err: error, siteId }, 'site request failed');
      send(response, 500, page('Fehler', 'Die Seite konnte nicht geladen werden.'), {
        'cache-control': 'no-store',
      });
    }
  }

  function start(tenantId: string, site: SiteRow, port: number): void {
    const host = hostFor(site);
    const existing = listeners.get(site.id);
    if (existing && existing.port === port && existing.host === host) return;
    if (existing) stop(site.id);

    const server = createServer((request, response) =>
      handle(tenantId, site.id, request, response),
    );
    server.on('error', (error) => {
      runtime.log.error({ err: error, port, siteId: site.id }, 'site listener failed');
    });
    server.listen(port, host);
    listeners.set(site.id, { server, port, host, tenantId, siteId: site.id });
    runtime.log.info({ siteId: site.id, port, host }, 'site listener started');
  }

  function stop(siteId: string): void {
    const listener = listeners.get(siteId);
    if (!listener) return;
    listener.server.close();
    listeners.delete(siteId);
  }

  function ensure(tenantId: string, site: SiteRow): SiteRow {
    if (!sites.enabled) return site;
    let current = site;
    if (current.internal_port === null) {
      const database = runtime.tenantDb(tenantId);
      const port = allocatePort(database, current.id);
      if (port === null) {
        runtime.log.warn({ siteId: site.id }, 'no free site port left');
        return current;
      }
      current = { ...current, internal_port: port };
    }
    const port = portFor(current);
    if (port !== null) start(tenantId, current, port);
    return current;
  }

  return {
    start() {
      if (!sites.enabled) return;
      for (const tenant of runtime.ctx.tenants()) {
        if (tenant.status !== 'active') continue;
        const database = runtime.tenantDb(tenant.id);
        const rows = database
          .prepare('select * from web_sites order by created_at, id')
          .all() as SiteRow[];
        for (const site of rows) ensure(tenant.id, site);
      }
    },
    ensure,
    stop,
    publicUrl,
    allocatePort,
    async stopAll() {
      await Promise.all(
        [...listeners.values()].map(
          (listener) =>
            new Promise<void>((resolveClose) => listener.server.close(() => resolveClose())),
        ),
      );
      listeners.clear();
    },
  };
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

export type { SiteRow };
