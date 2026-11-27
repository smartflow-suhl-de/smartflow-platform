import type { PluginContext } from '../../kernel/context.ts';
import { openSecretBox } from '../../kernel/secrets.ts';
import { AppError } from '../../kernel/errors.ts';
import { manifest } from './manifest.ts';
import { emailMigrations, getSettings } from './store.ts';
import { registerSettings } from './settings.ts';
import { registerOutbox, startWorker } from './outbox.ts';
import { createSync, registerInbox } from './inbox.ts';
import { nextRetentionRun, runRetention } from './retention.ts';

/**
 * One global sender (`operator` only) with a queue, plus a read-only IMAP copy
 * of `INBOX`. There is no tenant parameter: a shared address cannot be split per
 * tenant, and pretending otherwise would leak one customer's mail into another.
 */
export function register(ctx: PluginContext): void {
  // Plugin-scoped migration bookkeeping lives on the context; the tables
  // themselves are the plugin's own.
  ctx.migrate(emailMigrations);

  const box = openSecretBox(ctx.config.dataDir);
  const sync = createSync(ctx, box);
  const retentionDays = () => getSettings(ctx.db).retention_days;

  registerSettings(ctx, box);
  registerOutbox(ctx);
  registerInbox(ctx, sync, retentionDays);

  ctx.app.post(
    '/email/retention/run',
    {
      preHandler: ctx.app.requireRole('operator'),
      schema: { summary: 'Delete mail past the retention now', tags: ['email'] },
    },
    async (request) => {
      const body = (request.body ?? {}) as { confirm?: unknown };
      if (body.confirm !== true) {
        throw new AppError(
          'email_retention_shrink_unconfirmed',
          'Deleting mail past the retention needs a confirmation.',
          409,
        );
      }
      const result = runRetention(ctx.db, ctx.log, ctx.now(), 5000);
      return { deleted: result.deleted, remaining: result.remaining };
    },
  );

  // Sweep at startup and once a day at 03:00 UTC. A shortening also runs
  // inside `PUT /email/settings`, because a privacy promise cannot wait for
  // the nightly run.
  const sweep = () => {
    try {
      runRetention(ctx.db, ctx.log, ctx.now(), null);
    } catch (error) {
      ctx.log.warn({ err: error }, 'email retention sweep failed');
    }
  };
  setTimeout(sweep, 10_000).unref();
  const midnight = () => {
    const delay = new Date(nextRetentionRun(new Date())).getTime() - Date.now();
    const timer = setTimeout(() => {
      sweep();
      timer.refresh();
    }, Math.max(60_000, delay));
    timer.unref();
  };
  midnight();

  const stopWorker = startWorker(ctx, box);
  ctx.app.addHook('onClose', async () => {
    stopWorker();
  });
}

export default { manifest, register };