import nodemailer, { type SMTPTransportOptions, type Transporter } from 'nodemailer';
import type { SmtpConfig } from './config.ts';

/** The single message the kernel sends today: one sign-in link. */
export interface MagicLinkMail {
  to: string;
  link: string;
  expiresAt: string;
  locale: 'de' | 'en';
}

export interface MailerCloseOptions {
  /** Bound for the wait, so a dead relay cannot hang shutdown. */
  timeoutMs?: number;
  /** How many sends were still on the wire when the wait ended. */
  onStillOpen?: (count: number) => void;
}

/**
 * The seam between the auth route and the outside world. Tests implement it
 * with an in-memory stub, so `npm test` never opens a socket.
 */
export interface Mailer {
  /** False when no transport is configured: the API then says it sent nothing. */
  readonly isConfigured: boolean;
  sendMagicLink(mail: MagicLinkMail): Promise<void>;
  /**
   * Releases the transport. A send started by a request may still be on the
   * wire, so the result is awaited on shutdown instead of cut off there.
   */
  close(options?: MailerCloseOptions): void | Promise<void>;
}

/** How long shutdown waits for a send that is still on the wire. */
const CLOSE_TIMEOUT_MS = 5_000;

/**
 * Resolves once every promise settled, or when `timeoutMs` passed. Never
 * rejects: a send that failed must not make shutdown fail.
 */
async function settledWithin(promises: Promise<void>[], timeoutMs: number): Promise<void> {
  if (promises.length === 0) return;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([Promise.allSettled(promises), timeout]);
  } finally {
    clearTimeout(timer);
  }
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
  /** Sends handed to the transport that have not settled yet. */
  readonly #inflight = new Set<Promise<void>>();

  constructor(smtp: SmtpConfig, now: () => Date = () => new Date()) {
    if (smtp.host === null) throw new Error('NodemailerMailer needs SF_SMTP_HOST.');
    this.#from = smtp.from;
    this.#replyTo = smtp.replyTo;
    this.#options = {
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      // Without implicit TLS the session must still be upgraded before the
      // credentials and the message are sent. `requireTLS` makes nodemailer
      // refuse a plaintext relay instead of continuing unencrypted when an
      // active attacker strips STARTTLS from the greeting.
      ...(smtp.secure ? {} : { requireTLS: true }),
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
    // Tracked separately from the awaited call so shutdown can see a send that
    // the request path deliberately does not wait for.
    await this.#track(
      this.#transport()
        .sendMail({
          from: this.#from,
          to: mail.to,
          subject,
          text,
          ...(this.#replyTo !== null ? { replyTo: this.#replyTo } : {}),
        })
        .then(() => undefined),
    );
  }

  /** Removes the send from the in-flight set as part of its own settlement. */
  #track(send: Promise<void>): Promise<void> {
    this.#inflight.add(send);
    return send.finally(() => {
      this.#inflight.delete(send);
    });
  }

  async close(options: MailerCloseOptions = {}): Promise<void> {
    await settledWithin([...this.#inflight], options.timeoutMs ?? CLOSE_TIMEOUT_MS);
    const stillOpen = this.#inflight.size;
    if (stillOpen > 0) options.onStillOpen?.(stillOpen);
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

  close(): void {
    // Nothing to release.
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
