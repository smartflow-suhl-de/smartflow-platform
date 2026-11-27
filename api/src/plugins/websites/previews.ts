import { hashToken } from '../../kernel/crypto.ts';
import { invalidState, notFound } from '../../kernel/errors.ts';
import { newId, token } from '../../kernel/ids.ts';
import { findBuild, requireSite } from './store.ts';
import type { Runtime } from './runtime.ts';
import type { Delivery } from './delivery.ts';

/** Staff previews are short-lived; the approval link stays the client path. */
export const PREVIEW_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * The panel shows an address for every site, but a site only answers with a
 * published release or an approval link. Staff need to look at the current
 * build long before any client sees it, so this endpoint mints a short-lived
 * token for the newest successful build. It grants exactly one build, only
 * through the token, and leaves the release and approval state untouched.
 */
export function registerPreviews(runtime: Runtime, delivery: Delivery): void {
  runtime.app.post<{ Params: { siteId: string }; Body: { build_id?: string } }>(
    '/websites/:siteId/preview',
    {
      preHandler: runtime.app.requireRole('tenant_admin', 'employee', 'operator'),
      schema: {
        summary: 'Short-lived staff preview link for a finished build',
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { build_id: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const database = runtime.tenantDatabase(request);
      const site = requireSite(database, request.params.siteId);
      const buildId = request.body?.build_id;
      const build =
        buildId === undefined
          ? (database
              .prepare(
                `select id, status from web_builds
                  where site_id = ? order by created_at desc, id desc limit 1`,
              )
              .get(site.id) as { id: string; status: string } | undefined)
          : findBuild(database, site.id, buildId);
      if (!build) throw notFound('Build not found.');
      if (build.status !== 'ok') {
        throw invalidState('Only a successful build can be previewed.');
      }
      const siteUrl = delivery.publicUrl(site);
      if (siteUrl === null) {
        throw invalidState('This site has no address to preview yet.');
      }

      const now = runtime.now();
      const expiresAt = new Date(now.getTime() + PREVIEW_TTL_MS).toISOString();
      const plaintext = token(24);
      // Expired rows are dead weight and the table would otherwise grow with
      // every click; nothing else ever reads an expired token.
      database
        .prepare('delete from web_previews where site_id = ? and expires_at < ?')
        .run(site.id, now.toISOString());
      database
        .prepare(
          `insert into web_previews
             (id, site_id, build_id, token_hash, created_by, expires_at, created_at)
           values (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newId('prv'),
          site.id,
          build.id,
          hashToken(plaintext),
          request.user?.id ?? 'unknown',
          expiresAt,
          now.toISOString(),
        );
      reply.code(201);
      return { build_id: build.id, preview_url: `${siteUrl}?t=${plaintext}`, expires_at: expiresAt };
    },
  );
}
