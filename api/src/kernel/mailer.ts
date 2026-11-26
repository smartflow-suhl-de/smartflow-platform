import nodemailer, { type SMTPTransportOptions, type Transporter } from 'nodemailer';
import type { SmtpConfig } from './config.ts';

/** The single message the kernel sends today: one sign-in link. */
export interface MagicLinkMail {
  to: string;
  link: string;
  expiresAt: string;
  locale: 'de' | 'en';
}

/**
 * The seam between the auth route and the outside world. Tests implement it
 * with an in-memory stub, so `npm test` never opens a socket.
 */
export interface Mailer {
  /** False when no transport is configured: the API then says it sent nothing. */
  readonly isConfigured: boolean;
  sendMagicLink(mail: MagicLinkMail): Promise<void>;
}

interface RenderedMail {
  subject: string;
  text: string;
}

/** Minutes until the link dies, as the reader sees it. Rounded up, never below 1. */
function minutesLeft(expiresAt: string, now: Date): number {
  const remaining = new Date(expiresAt).getTime() - now.getTime();
  if (!Number.isFinite(remaining)) return 1;
  return Math.max(1, Math.round(remaining / 60_000));
}

/**
 * The message body, kept separate from the transport so the wording is
 * testable without a socket and both locales stay in one place.
 */
export function renderMagicLinkMail(mail: MagicLinkMail, now: Date): RenderedMail {
  const minutes = minutesLeft(mail.expiresAt, now);

  if (mail.locale === 'en') {
    return {
      subject: 'Your SmartFlow sign-in link',
      text: [
        'Hello,',
        '',
        'here is your single-use sign-in link for SmartFlow:',
        '',
        mail.link,
        '',
        `The link is valid for ${minutes} minutes and can be used once.`,
        '',
        'If you did not request this link, you can ignore this email. Nothing happens until the link is opened.',
        '',
        'SmartFlow · Suhl',
      ].join('\n'),
    };
  }

  return {
    subject: 'Ihr SmartFlow-Anmeldelink',
    text: [
      'Guten Tag,',
      '',
      'hier ist Ihr einmaliger Anmeldelink für SmartFlow:',
      '',
      mail.link,
      '',
      `Der Link ist ${minutes} Minuten gültig und kann einmal verwendet werden.`,
      '',
      'Falls Sie diesen Link nicht angefordert haben, können Sie diese E-Mail ignorieren. Ohne Klick auf den Link passiert nichts.',
      '',
      'SmartFlow · Suhl',
    ].join('\n'),
  };
}

/**
 * Sends through SMTP. One connection pool per process, opened lazily by
 * nodemailer on the first message and closed with the app.
 */
export class NodemailerMailer implements Mailer {
  readonly isConfigured = true;
  readonly #from: string;
  readonly #replyTo: string | null;
  readonly #options: SMTPTransportOptions;
  readonly #now: () => Date;
  #transporter: Transporter | null = null;

  constructor(smtp: SmtpConfig, now: () => Date = () => new Date()) {
    if (smtp.host === null) throw new Error('NodemailerMailer needs SF_SMTP_HOST.');
    this.#from = smtp.from;
    this.#replyTo = smtp.replyTo;
    this.#options = {
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      ...(smtp.user !== null && smtp.pass !== null
        ? { auth: { user: smtp.user, pass: smtp.pass } }
        : {}),
    };
    this.#now = now;
  }

  #transport(): Transporter {
    this.#transporter ??= nodemailer.createTransport(this.#options);
    return this.#transporter;
  }

  async sendMagicLink(mail: MagicLinkMail): Promise<void> {
    const { subject, text } = renderMagicLinkMail(mail, this.#now());
    await this.#transport().sendMail({
      from: this.#from,
      to: mail.to,
      subject,
      text,
      ...(this.#replyTo !== null ? { replyTo: this.#replyTo } : {}),
    });
  }

  close(): void {
    this.#transporter?.close();
    this.#transporter = null;
  }
}

/** The state a process without `SF_SMTP_HOST` runs in. It never sends. */
export class NoopMailer implements Mailer {
  readonly isConfigured = false;

  async sendMagicLink(_mail: MagicLinkMail): Promise<void> {
    // Unreachable by design: the route checks `isConfigured` before calling.
  }
}

/**
 * Picks the language of the mail from `Accept-Language`, defaulting to German.
 * Only the first supported tag decides: `en-US, de;q=0.9` wants English, and a
 * header without a `de`/`en` entry falls back to German.
 */
export function localeFromAcceptLanguage(header: string | undefined): 'de' | 'en' {
  const first = (header ?? '')
    .split(',')
    .map((part) => part.split(';')[0]?.trim().toLowerCase() ?? '')
    .find((tag) => tag === 'de' || tag === 'en' || tag.startsWith('de-') || tag.startsWith('en-'));
  return first?.startsWith('en') === true ? 'en' : 'de';
}
