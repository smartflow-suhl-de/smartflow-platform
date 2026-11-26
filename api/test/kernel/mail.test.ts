import assert from 'node:assert/strict';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import { createTestApp, RecordingMailer, settleDelivery } from './helpers.ts';

const OPERATOR = 'operator@example.com';

/**
 * The dev link is off in these tests: with `SF_DEV_MAGIC_LINK` on the response
 * carries the link and `sent` describes that dev delivery instead of the mail.
 * Transport behaviour is what is under test here.
 */
const NO_DEV_LINK = { SF_DEV_MAGIC_LINK: '0' };

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
  // The renderer rounds up, so a link that just expired still reads as 1 minute.
  assert.match(
    renderMagicLinkMail(
      { to: OPERATOR, link: 'x', expiresAt: '2020-01-01T00:00:00.000Z', locale: 'de' },
      new Date('2026-01-01T00:00:00.000Z'),
    ).text,
    /1 Minuten/,
  );
});

test('the SMTP mailer hands from, to, subject and text to nodemailer', async (t) => {
  // `nodemailer.createTransport` is stubbed so this test inspects the message
  // instead of opening a connection: `npm test` must not touch the network.
  const nodemailer = (await import('nodemailer')).default;
  const captured: Record<string, unknown>[] = [];
  const original = nodemailer.createTransport;
  nodemailer.createTransport = ((..._args: unknown[]) => ({
    sendMail: async (message: Record<string, unknown>) => {
      captured.push(message);
      return { accepted: [message.to] };
    },
    close: () => undefined,
  })) as unknown as typeof nodemailer.createTransport;
  t.after(() => {
    nodemailer.createTransport = original;
  });

  const { NodemailerMailer } = await import('../../src/kernel/mailer.ts');
  const now = new Date('2026-01-01T10:00:00.000Z');
  const sender = ['versand', 'example.test'].join('@');
  const replyTo = ['antwort', 'example.test'].join('@');
  const mailer = new NodemailerMailer(
    {
      host: 'mail.example.test',
      port: 587,
      secure: false,
      user: 'smartflow',
      pass: 'test-pass',
      from: sender,
      replyTo,
    },
    () => now,
  );

  const link = `${'https://app.example.test'}/login/confirm?token=${'c'.repeat(43)}`;
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
  await mailer.sendMagicLink({ to: OPERATOR, link, expiresAt, locale: 'de' });
  mailer.close();

  assert.equal(mailer.isConfigured, true);
  assert.equal(captured.length, 1);
  const message = captured[0];
  assert.equal(message?.from, sender);
  assert.equal(message?.to, OPERATOR);
  assert.equal(message?.replyTo, replyTo);
  assert.equal(message?.subject, 'Ihr SmartFlow-Anmeldelink');
  assert.ok(String(message?.text).includes(link));
});

test('the SMTP mailer refuses a config without a host', async () => {
  const { NodemailerMailer } = await import('../../src/kernel/mailer.ts');

  assert.throws(
    () =>
      new NodemailerMailer({
        host: null,
        port: 587,
        secure: false,
        user: null,
        pass: null,
        from: OPERATOR,
        replyTo: null,
      }),
    /SF_SMTP_HOST/,
  );
});
