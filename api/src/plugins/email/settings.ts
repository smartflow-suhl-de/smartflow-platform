import type { PluginContext } from '../../kernel/context.ts';
import type { SecretBox } from '../../kernel/secrets.ts';
import { FieldError } from '../../shared/contract.ts';
import { AppError } from '../../kernel/errors.ts';
import { newId } from '../../kernel/ids.ts';
import {
  getMailbox,
  getSettings,
  isConfigured,
  publicSender,
  publicTransport,
  type TlsMode,
} from './store.ts';
import {
  lastRetentionRun,
  nextRetentionRun,
  pendingRows,
  runRetention,
  type RetentionResult,
} from './retention.ts';

const RETENTION_MIN = 7;
const RETENTION_MAX = 3650;
const PRESETS = [30, 90, 180, 365];
const ADDRESS = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const HOST = /^[^\s/\\]+$/;

export interface SettingsEffect {
  shortened: boolean;
  deleted: number;
  remaining: number;
}

function requireText(fields: Record<string, string>, key: string, value: unknown, max: number): string {
  const raw = typeof value === 'string' ? value : '';
  if (raw.trim().length === 0 || raw.length > max || /[\r\n]/.test(raw)) {
    fields[key] = `Please enter 1 to ${max} characters without line breaks.`;
    return '';
  }
  return raw.trim();
}

function optionalAddress(fields: Record<string, string>, key: string, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !ADDRESS.test(value.trim()) || /[\r\n]/.test(value)) {
    fields[key] = 'Please enter a single valid email address.';
    return null;
  }
  return value.trim();
}

function requireAddress(fields: Record<string, string>, key: string, value: unknown): string {
  const address = optionalAddress(fields, key, value);
  if (!address && !fields[key]) fields[key] = 'Please enter a single valid email address.';
  return address ?? '';
}

function requireHost(fields: Record<string, string>, key: string, value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0 || raw.length > 253 || !HOST.test(raw) || /\s/.test(raw)) {
    fields[key] = 'Please enter a host name without scheme, path or spaces.';
    return '';
  }
  return raw;
}

function requirePort(fields: Record<string, string>, key: string, value: unknown): number {
  const port = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fields[key] = 'Please enter a port between 1 and 65535.';
    return 587;
  }
  return port;
}

function requireTls(fields: Record<string, string>, key: string, value: unknown): TlsMode {
  if (value === 'tls' || value === 'starttls') return value;
  fields[key] = 'Please choose STARTTLS or TLS.';
  return 'starttls';
}

/**
 * `undefined` keeps the stored secret, `null` clears it, a string replaces it.
 * The client never reads a secret back, so "keep" has to be the default.
 */
function nextSecret(
  fields: Record<string, string>,
  key: string,
  value: unknown,
  box: SecretBox,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    fields[key] = 'Please enter a password of 1 to 512 characters.';
    return undefined;
  }
  return box.seal(value);
}

function settingsView(ctx: PluginContext, now: Date) {
  const settings = getSettings(ctx.db);
  const mailbox = getMailbox(ctx.db);
  return {
    status: isConfigured(settings) ? 'configured' : 'unconfigured',
    sender: publicSender(settings),
    transport: publicTransport(settings),
    mailbox: {
      host: mailbox.host,
      port: mailbox.port,
      tls_mode: mailbox.tls_mode,
      username: mailbox.username,
      password_set: Boolean(mailbox.password_sealed),
      address: mailbox.address,
      configured: Boolean(mailbox.host && mailbox.username && mailbox.password_sealed),
    },
    retention: {
      days: settings.retention_days,
      min_days: RETENTION_MIN,
      max_days: RETENTION_MAX,
      presets: PRESETS,
      scope: 'global',
      pending_rows: pendingRows(ctx.db, settings, now),
      last_run_at: lastRetentionRun(ctx.db),
      next_run_at: nextRetentionRun(now),
    },
    updated_at: settings.updated_at || null,
  };
}

export function registerSettings(ctx: PluginContext, box: SecretBox): void {
  const { app, db, now } = ctx;
  const operator = app.requireRole('operator');
  const testRuns = new Map<string, number>();

  app.get(
    '/email/settings',
    { preHandler: operator, schema: { summary: 'Read the mail settings', tags: ['email'] } },
    async () => settingsView(ctx, now()),
  );

  app.put(
    '/email/settings',
    { preHandler: operator, schema: { summary: 'Replace the mail settings', tags: ['email'] } },
    async (request) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const sender = (body.sender ?? {}) as Record<string, unknown>;
      const transport = (body.transport ?? {}) as Record<string, unknown>;
      const mailboxInput = body.mailbox as Record<string, unknown> | undefined;
      const retention = (body.retention ?? {}) as Record<string, unknown>;
      const fields: Record<string, string> = {};

      const fromName = requireText(fields, 'sender.name', sender.name, 80);
      const fromAddress = requireAddress(fields, 'sender.address', sender.address);
      const replyTo = optionalAddress(fields, 'sender.reply_to', sender.reply_to);

      const host = requireHost(fields, 'transport.host', transport.host);
      const port = requirePort(fields, 'transport.port', transport.port);
      const tlsMode = requireTls(fields, 'transport.tls_mode', transport.tls_mode);
      const username = requireText(fields, 'transport.username', transport.username, 200);
      const sealed = nextSecret(fields, 'transport.password', transport.password, box);

      const days = typeof retention.days === 'number' ? retention.days : Number.NaN;
      if (!Number.isInteger(days) || days < RETENTION_MIN || days > RETENTION_MAX) {
        fields['retention.days'] = `Please enter ${RETENTION_MIN} to ${RETENTION_MAX} days.`;
      }

      let mailboxHost: string | undefined;
      let mailboxPort: number | undefined;
      let mailboxTls: TlsMode | undefined;
      let mailboxUser: string | undefined;
      let mailboxAddress: string | null | undefined;
      let mailboxSealed: string | null | undefined;
      if (mailboxInput !== undefined) {
        mailboxHost = requireHost(fields, 'mailbox.host', mailboxInput.host);
        mailboxPort = requirePort(fields, 'mailbox.port', mailboxInput.port);
        mailboxTls = requireTls(fields, 'mailbox.tls_mode', mailboxInput.tls_mode);
        mailboxUser = requireText(fields, 'mailbox.username', mailboxInput.username, 200);
        mailboxAddress = optionalAddress(fields, 'mailbox.address', mailboxInput.address);
        if (!mailboxAddress && !fields['mailbox.address']) {
          fields['mailbox.address'] = 'Please enter a single valid email address.';
        }
        mailboxSealed = nextSecret(fields, 'mailbox.password', mailboxInput.password, box);
      }

      if (Object.keys(fields).length > 0) throw new FieldError(fields);

      const current = getSettings(db);
      const shortening = days < current.retention_days;
      if (shortening && body.confirm_shortening !== true) {
        throw new AppError(
          'email_retention_shrink_unconfirmed',
          'Shortening the retention deletes mail. Confirm the exact difference first.',
          409,
        );
      }

      const stamp = now().toISOString();
      const updatedBy = request.user?.email ?? 'operator';
      ctx.db.transaction(() => {
        db.prepare(
          `update email_settings
              set host = ?, port = ?, tls_mode = ?, username = ?,
                  password_sealed = coalesce(?, password_sealed),
                  from_address = ?, from_name = ?, reply_to = ?,
                  retention_days = ?, updated_at = ?, updated_by = ?
            where id = 1`,
        ).run(
          host,
          port,
          tlsMode,
          username,
          sealed === undefined ? null : sealed,
          fromAddress,
          fromName,
          replyTo,
          days,
          stamp,
          updatedBy,
        );
        if (sealed === null) db.prepare('update email_settings set password_sealed = null where id = 1').run();

        if (mailboxInput !== undefined) {
          db.prepare(
            `update email_mailbox
                set host = ?, port = ?, tls_mode = ?, username = ?,
                    password_sealed = coalesce(?, password_sealed),
                    address = ?, updated_at = ?
              where id = 1`,
          ).run(
            mailboxHost ?? '',
            mailboxPort ?? 993,
            mailboxTls ?? 'tls',
            mailboxUser ?? '',
            mailboxSealed === undefined ? null : mailboxSealed,
            mailboxAddress ?? '',
            stamp,
          );
          if (mailboxSealed === null) {
            db.prepare('update email_mailbox set password_sealed = null where id = 1').run();
          }
        }
      })();

      let effect: SettingsEffect = { shortened: false, deleted: 0, remaining: 0 };
      if (shortening) {
        const result: RetentionResult = runRetention(db, ctx.log, now(), 5000);
        effect = { shortened: true, deleted: result.deleted, remaining: result.remaining };
      }
      return { ...settingsView(ctx, now()), retention_effect: effect };
    },
  );

  app.post(
    '/email/settings/test',
    { preHandler: operator, schema: { summary: 'Queue a test mail to the operator', tags: ['email'] } },
    async (request, reply) => {
      const settings = getSettings(db);
      if (!isConfigured(settings)) {
        throw new AppError('email_not_configured', 'The mail settings are incomplete.', 409);
      }
      const user = request.user;
      if (!user) throw new AppError('unauthorized', 'Sign-in required.', 401);
      const last = testRuns.get(user.id) ?? 0;
      if (Date.now() - last < 10_000) {
        throw new AppError('email_rate_limited', 'Please wait before sending another test.', 429);
      }
      testRuns.set(user.id, Date.now());

      const stamp = now().toISOString();
      const id = newId('eml');
      db.prepare(
        `insert into email_outbox
           (id, tenant_id, to_address, to_name, subject, text_body, html_body, reply_to,
            dedupe_key, status, attempts, next_attempt_at, created_at)
         values (?, null, ?, null, ?, ?, null, null, null, 'queued', 0, ?, ?)`,
      ).run(
        id,
        user.email,
        'SmartFlow Testnachricht',
        'Diese Nachricht bestätigt, dass der globale Absender erreichbar ist.',
        stamp,
        stamp,
      );
      reply.code(202);
      return { id, status: 'queued' };
    },
  );
}