import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { createTestApp, RecordingMailer, settleDelivery } from './helpers.ts';

const OPERATOR = 'operator@example.com';

/**
 * The dev link is off in these tests: with `SF_DEV_MAGIC_LINK` on the response
 * carries the link and `sent` describes that dev delivery instead of the mail.
 * Transport behaviour is what is under test here.
 */
const NO_DEV_LINK = { SF_DEV_MAGIC_LINK: '0' };

/**
 * Replaces `nodemailer.createTransport` for one test so the message and the
 * transport options can be inspected instead of a socket being opened:
 * `npm test` must never touch the network.
 */
async function stubNodemailer(
  t: TestContext,
  sendMail: (message: Record<string, unknown>) => Promise<unknown> = async () => ({
    accepted: [],
  }),
): Promise<{
  options: Record<string, unknown>;
  messages: Record<string, unknown>[];
  closed: boolean;
}> {
  const nodemailer = (await import('nodemailer')).default;
  const original = nodemailer.createTransport;
  const state = {
    options: {} as Record<string, unknown>,
    messages: [] as Record<string, unknown>[],
    closed: false,
  };
  nodemailer.createTransport = ((options: Record<string, unknown>) => {
    state.options = options;
    return {
      sendMail(message: Record<string, unknown>) {
        state.messages.push(message);
        return sendMail(message);
      },
      close() {
        state.closed = true;
      },
    };
  }) as unknown as typeof nodemailer.createTransport;
  t.after(() => {
    nodemailer.createTransport = original;
  });
  return state;
}

/** Collects what pino writes instead of sending it to stdout. */
function captureLog(): { lines: string[]; write(line: string): void } {
  const lines: string[] = [];
  return {
    lines,
    write(line: string) {
      lines.push(line);
    },
  };
}

/**
 * A complete `SmtpConfig`. `requireTls` and `allowPlaintext` follow the same rule
 * as `loadSmtp` so a test never has to spell out the TLS policy it is not about.
 */
async function smtpConfig(overrides: {
  host?: string | null;
  port?: number;
  secure?: boolean;
  user?: string | null;
  pass?: string | null;
  from?: string;
  replyTo?: string | null;
  allowPlaintext?: boolean;
}): Promise<import('../../src/kernel/config.ts').SmtpConfig> {
  const secure = overrides.secure ?? false;
  const allowPlaintext = overrides.allowPlaintext ?? false;
  return {
    host: overrides.host === undefined ? 'mail.example.test' : overrides.host,
    port: overrides.port ?? 587,
    secure,
    requireTls: !secure && !allowPlaintext,
    user: overrides.user ?? 'smartflow',
    pass: overrides.pass ?? 'SI_SECRET_PASSWORD_7QK2M4ZT',
    from: overrides.from ?? OPERATOR,
    replyTo: overrides.replyTo ?? null,
    allowPlaintext,
  };
}

function magicLink(app: FastifyInstance, email: string, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/magic-link',
    payload: { email },
    headers,
  });
}

test('the sign-in link is mailed to the operator', async (t) => {
  const mailer = new RecordingMailer();
  const ctx = await createTestApp(NO_DEV_LINK, { mailer });
  t.after(() => ctx.close());

  const response = await magicLink(ctx.app, OPERATOR);
  await settleDelivery();

  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), {
    sent: true,
    expiresAt: (response.json() as { expiresAt: string }).expiresAt,
  });

  assert.equal(mailer.sent.length, 1);
  const [mail] = mailer.sent;
  assert.equal(mail?.to, OPERATOR);
  assert.equal(mail?.locale, 'de');
  // The link is the one the API issued: same confirm route, the same token the
  // database hashed.
  assert.match(
    mail?.link ?? '',
    /^http:\/\/127\.0\.0\.1:5273\/login\/confirm\?token=[A-Za-z0-9_-]{43}$/,
  );
  assert.equal(mail?.expiresAt, (response.json() as { expiresAt: string }).expiresAt);
  assert.doesNotMatch(response.payload, /token=/, 'the response must not carry the link');
});

test('the mail names the validity in minutes and says what to do if it was not requested', async (t) => {
  const mailer = new RecordingMailer();
  const ctx = await createTestApp(NO_DEV_LINK, { mailer });
  t.after(() => ctx.close());

  await magicLink(ctx.app, OPERATOR);
  await settleDelivery();

  const { renderMagicLinkMail } = await import('../../src/kernel/mailer.ts');
  const mail = mailer.sent[0];
  assert.ok(mail);
  const { subject, text } = renderMagicLinkMail(mail, new Date());

  assert.equal(subject, 'Ihr SmartFlow-Anmeldelink');
  assert.match(text, /15 Minuten/);
  assert.match(text, /einmalig/);
  assert.match(text, /nicht angefordert/);
  assert.ok(text.includes(mail.link), 'the link is part of the body');
});

test('the English text carries the same facts', async () => {
  const { renderMagicLinkMail } = await import('../../src/kernel/mailer.ts');
  const now = new Date('2026-01-01T10:00:00.000Z');
  const link = `${'https://app.example.test'}/login/confirm?token=${'b'.repeat(43)}`;
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();

  const { subject, text } = renderMagicLinkMail(
    { to: OPERATOR, link, expiresAt, locale: 'en' },
    now,
  );

  assert.equal(subject, 'Your SmartFlow sign-in link');
  assert.match(text, /15 minutes/);
  assert.match(text, /single-use|once/);
  assert.match(text, /did not request/);
  assert.ok(text.includes(link));
});

test('the validity reads in the singular for exactly one minute', async () => {
  const { renderMagicLinkMail } = await import('../../src/kernel/mailer.ts');
  const now = new Date('2026-01-01T10:00:00.000Z');
  // 40 seconds left: the link is still usable, so the text must say one minute
  // rather than zero or "1 Minuten".
  const expiresAt = new Date(now.getTime() + 40_000).toISOString();

  for (const [locale, expected] of [
    ['de', 'Der Link ist 1 Minute gültig'],
    ['en', 'The link is valid for 1 minute '],
  ] as const) {
    const { text } = renderMagicLinkMail({ to: OPERATOR, link: 'x', expiresAt, locale }, now);
    assert.ok(text.includes(expected), `${locale}: ${text}`);
  }
});

test('a partly elapsed TTL never reads as less than the page promises', async () => {
  const { renderMagicLinkMail } = await import('../../src/kernel/mailer.ts');
  const now = new Date('2026-01-01T10:00:00.000Z');
  // 14 minutes 30 seconds left: rounding down would say 14 while the login page
  // promises 15 minutes.
  const expiresAt = new Date(now.getTime() + 14.5 * 60_000).toISOString();

  assert.match(
    renderMagicLinkMail({ to: OPERATOR, link: 'x', expiresAt, locale: 'de' }, now).text,
    /Der Link ist 15 Minuten gültig/,
  );
});

test('an English Accept-Language gets the English mail', async (t) => {
  const mailer = new RecordingMailer();
  const ctx = await createTestApp(NO_DEV_LINK, { mailer });
  t.after(() => ctx.close());

  await magicLink(ctx.app, OPERATOR, { 'accept-language': 'en-GB,en;q=0.9' });
  await settleDelivery();

  assert.equal(mailer.sent[0]?.locale, 'en');
});

test('an unknown address gets the same 202 and no mail', async (t) => {
  const mailer = new RecordingMailer();
  const ctx = await createTestApp(NO_DEV_LINK, { mailer });
  t.after(() => ctx.close());

  const known = await magicLink(ctx.app, OPERATOR);
  const unknown = await magicLink(ctx.app, 'unbekannt@example.test');
  await settleDelivery();

  assert.equal(known.statusCode, 202);
  assert.equal(unknown.statusCode, 202);
  assert.deepEqual(Object.keys(unknown.json()).sort(), Object.keys(known.json()).sort());
  assert.equal((unknown.json() as { sent: boolean }).sent, true);
  assert.equal(mailer.sent.length, 1, 'only the known address was mailed');
  assert.equal(mailer.sent[0]?.to, OPERATOR);
});

test('without a transport the answer says sent:false and nothing is mailed', async (t) => {
  const mailer = new RecordingMailer({ configured: false });
  const ctx = await createTestApp(NO_DEV_LINK, { mailer });
  t.after(() => ctx.close());

  const known = await magicLink(ctx.app, OPERATOR);
  const unknown = await magicLink(ctx.app, 'unbekannt@example.test');
  await settleDelivery();

  for (const response of [known, unknown]) {
    assert.equal(response.statusCode, 202);
    const body = response.json() as { sent: boolean; expiresAt: string; link?: string };
    assert.equal(body.sent, false);
    assert.ok(body.expiresAt);
    assert.equal(body.link, undefined);
  }
  assert.equal(mailer.sent.length, 0);
});

test('a transport failure still answers 202 and logs neither token nor address', async (t) => {
  const log = captureLog();
  const mailer = new RecordingMailer();
  mailer.failWith(
    Object.assign(new Error(`relay refused for ${OPERATOR}`), {
      code: 'EENVELOPE',
      responseCode: 550,
    }),
  );
  const ctx = await createTestApp(
    { ...NO_DEV_LINK, SF_LOG_LEVEL: 'info' },
    { logStream: log, mailer },
  );
  t.after(() => ctx.close());

  const response = await magicLink(ctx.app, OPERATOR);
  await settleDelivery();

  assert.equal(response.statusCode, 202);
  assert.equal((response.json() as { sent: boolean }).sent, true);

  const output = log.lines.join('\n');
  assert.match(output, /magic link mail could not be sent/);
  assert.match(output, /"code":"EENVELOPE"/);
  assert.match(output, /"responseCode":550/);
  assert.equal(output.includes(OPERATOR), false, 'the plaintext address reached the log');
  assert.equal(output.includes('token='), false, 'the sign-in link reached the log');
  assert.equal(output.includes('relay refused'), false, 'the relay message reached the log');
  // A bare SHA-256 of an address is reversible for a known domain, so the log
  // must carry a keyed pseudonym instead — and that pseudonym must be stable.
  const { pseudonymize } = await import('../../src/kernel/crypto.ts');
  const { loadOrCreateKey } = await import('../../src/kernel/secrets.ts');
  const expected = pseudonymize(OPERATOR, loadOrCreateKey(ctx.config.dataDir)).slice(0, 16);
  assert.match(output, new RegExp(`"recipient":"${expected}"`));
  assert.notEqual(
    expected,
    (await import('../../src/kernel/crypto.ts')).hashToken(OPERATOR).slice(0, 16),
  );
});

test('the locale helper reads only the first supported tag', async () => {
  const { localeFromAcceptLanguage } = await import('../../src/kernel/mailer.ts');

  assert.equal(localeFromAcceptLanguage(undefined), 'de');
  assert.equal(localeFromAcceptLanguage(''), 'de');
  assert.equal(localeFromAcceptLanguage('de-DE'), 'de');
  assert.equal(localeFromAcceptLanguage('en'), 'en');
  assert.equal(localeFromAcceptLanguage('en-US,de;q=0.9'), 'en');
  assert.equal(localeFromAcceptLanguage('fr-FR,en;q=0.8'), 'en');
  assert.equal(localeFromAcceptLanguage('fr-FR'), 'de');
});

test('the no-op mailer reports that it is not configured', async () => {
  const { NoopMailer, renderMagicLinkMail } = await import('../../src/kernel/mailer.ts');
  const mailer = new NoopMailer();

  assert.equal(mailer.isConfigured, false);
  await assert.doesNotReject(() =>
    mailer.sendMagicLink({
      to: OPERATOR,
      link: 'x',
      expiresAt: new Date().toISOString(),
      locale: 'de',
    }),
  );
  // The renderer rounds up, so a link that just expired still reads as 1 minute —
  // and in the singular, not "1 Minuten".
  assert.match(
    renderMagicLinkMail(
      { to: OPERATOR, link: 'x', expiresAt: '2020-01-01T00:00:00.000Z', locale: 'de' },
      new Date('2026-01-01T00:00:00.000Z'),
    ).text,
    /Der Link ist 1 Minute gültig/,
  );
});

test('the SMTP mailer hands from, to, subject and text to nodemailer', async (t) => {
  const transport = await stubNodemailer(t);

  const { NodemailerMailer } = await import('../../src/kernel/mailer.ts');
  const now = new Date('2026-01-01T10:00:00.000Z');
  const sender = ['versand', 'example.test'].join('@');
  const replyTo = ['antwort', 'example.test'].join('@');
  const mailer = new NodemailerMailer(
    await smtpConfig({ from: sender, replyTo, pass: 'test-pass' }),
    () => now,
  );

  const link = `${'https://app.example.test'}/login/confirm?token=${'c'.repeat(43)}`;
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
  await mailer.sendMagicLink({ to: OPERATOR, link, expiresAt, locale: 'de' });
  await mailer.close();

  assert.equal(mailer.isConfigured, true);
  assert.equal(transport.messages.length, 1);
  const message = transport.messages[0];
  assert.equal(message?.from, sender);
  assert.equal(message?.to, OPERATOR);
  assert.equal(message?.replyTo, replyTo);
  assert.equal(message?.subject, 'Ihr SmartFlow-Anmeldelink');
  assert.ok(String(message?.text).includes(link));
});

test('the STARTTLS path demands an upgrade and implicit TLS does not', async (t) => {
  const transport = await stubNodemailer(t);
  const { NodemailerMailer } = await import('../../src/kernel/mailer.ts');
  const smtp = await smtpConfig({ pass: 'SI_SECRET_PASSWORD_2H6GVB4Q' });
  const mail = {
    to: OPERATOR,
    link: 'https://app.example.test/login/confirm?token=x',
    expiresAt: new Date().toISOString(),
    locale: 'de' as const,
  };

  await new NodemailerMailer(smtp).sendMagicLink(mail);
  // A relay that strips STARTTLS from its greeting must make the send fail
  // instead of receiving password and link in cleartext.
  assert.equal(transport.options.requireTLS, true);
  assert.equal(transport.options.secure, false);

  await new NodemailerMailer(await smtpConfig({ port: 465, secure: true })).sendMagicLink(mail);
  // Implicit TLS negotiates the session before the greeting, so `requireTLS`
  // (a STARTTLS demand) has no place there.
  assert.equal(transport.options.requireTLS, undefined);
  assert.equal(transport.options.secure, true);
});

test('the plaintext opt-in is the only way to skip the STARTTLS demand', async (t) => {
  const transport = await stubNodemailer(t);
  const { NodemailerMailer } = await import('../../src/kernel/mailer.ts');
  const mail = {
    to: OPERATOR,
    link: 'https://app.example.test/login/confirm?token=x',
    expiresAt: new Date().toISOString(),
    locale: 'de' as const,
  };

  await new NodemailerMailer(
    await smtpConfig({ allowPlaintext: true, user: null, pass: null }),
  ).sendMagicLink(mail);

  // A local sink without TLS (Mailpit) keeps working, but only because the
  // operator asked for it explicitly — and the app warns at startup.
  assert.equal(transport.options.requireTLS, undefined);
  assert.equal(transport.options.secure, false);
});

test('close waits for a send that is still on the wire', async (t) => {
  let release: (() => void) | undefined;
  const transport = await stubNodemailer(
    t,
    () =>
      new Promise((resolve) => {
        release = () => resolve({ accepted: [OPERATOR] });
      }),
  );
  const { NodemailerMailer } = await import('../../src/kernel/mailer.ts');
  const mailer = new NodemailerMailer(await smtpConfig({ user: null, pass: null }));

  // The route never awaits the send, so shutdown runs while it is open.
  const send = mailer.sendMagicLink({
    to: OPERATOR,
    link: 'https://app.example.test/login/confirm?token=x',
    expiresAt: new Date().toISOString(),
    locale: 'de',
  });

  let closed = false;
  const stillOpen: number[] = [];
  const closing = mailer.close({ onStillOpen: (count) => stillOpen.push(count) }).then(() => {
    closed = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false, 'close returned before the send settled');
  assert.equal(transport.closed, false, 'the transport was closed underneath the send');

  release?.();
  await closing;
  await send;

  assert.equal(closed, true);
  assert.equal(transport.closed, true);
  assert.deepEqual(stillOpen, [], 'the send settled inside the wait');
});

test('close gives up on a stuck send and reports how many stayed open', async (t) => {
  // A relay that never answers must not hold the shutdown forever.
  await stubNodemailer(t, () => new Promise(() => {}));
  const { NodemailerMailer } = await import('../../src/kernel/mailer.ts');
  const mailer = new NodemailerMailer(
    await smtpConfig({ port: 465, secure: true, user: null, pass: null }),
  );

  void mailer.sendMagicLink({
    to: OPERATOR,
    link: 'https://app.example.test/login/confirm?token=x',
    expiresAt: new Date().toISOString(),
    locale: 'de',
  });

  const open: number[] = [];
  await mailer.close({ timeoutMs: 10, onStillOpen: (count) => open.push(count) });

  assert.deepEqual(open, [1], 'shutdown must be able to log the open sends');
});

test('closing the app releases the transport it was built with', async (t) => {
  const mailer = new RecordingMailer();
  const ctx = await createTestApp(NO_DEV_LINK, { mailer });
  t.after(async () => {
    await ctx.close();
  });

  await magicLink(ctx.app, OPERATOR);
  await settleDelivery();
  await ctx.app.close();

  assert.equal(mailer.closed, true);
});

test('the SMTP mailer refuses a config without a host', async () => {
  const { NodemailerMailer } = await import('../../src/kernel/mailer.ts');
  const noHost = await smtpConfig({ host: null, user: null, pass: null });

  assert.throws(() => new NodemailerMailer(noHost), /SF_SMTP_HOST/);
});
