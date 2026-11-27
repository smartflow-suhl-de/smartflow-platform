import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import sanitizeHtml from 'sanitize-html';
import type { MailboxRow } from './store.ts';

/** Mail larger than this is kept as metadata only, never as a body. */
const BODY_LIMIT = 1_048_576;
/** First sync: the newest 100 messages, not the whole archive. */
const FIRST_SYNC_LIMIT = 100;

export interface ParsedMessage {
  uid: number;
  messageId: string | null;
  fromAddress: string;
  fromName: string | null;
  subject: string;
  snippet: string;
  textBody: string | null;
  htmlBody: string | null;
  receivedAt: string;
  unread: boolean;
  attachmentCount: number;
}

export interface FetchedInbox {
  uidValidity: number;
  uidNext: number;
  messages: ParsedMessage[];
}

/**
 * Read-only IMAP: `BODY.PEEK` semantics through imapflow's fetch, no flags
 * written, only `INBOX`, certificate verification on. A failure closes the
 * connection and surfaces as one code, never as SMTP/IMAP text.
 */
export async function fetchInbox(
  mailbox: MailboxRow,
  password: string,
  known: { uidValidity: number | null; uidNext: number | null },
): Promise<FetchedInbox> {
  const client = new ImapFlow({
    host: mailbox.host,
    port: mailbox.port,
    secure: mailbox.tls_mode === 'tls',
    auth: { user: mailbox.username, pass: password },
    logger: false,
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 20_000,
  });

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const box = client.mailbox;
    if (!box) throw new Error('INBOX could not be opened.');
    const uidValidity = Number(box.uidValidity);
    const uidNext = Number(box.uidNext);
    const sameMailbox = known.uidValidity === uidValidity;
    const startUid = sameMailbox && known.uidNext ? Math.max(1, known.uidNext) : Math.max(1, uidNext - FIRST_SYNC_LIMIT);
    if (startUid >= uidNext) {
      return { uidValidity, uidNext, messages: [] };
    }

    const messages: ParsedMessage[] = [];
    for await (const message of client.fetch(
      `${startUid}:*`,
      {
        uid: true,
        envelope: true,
        flags: true,
        internalDate: true,
        size: true,
        source: { maxLength: BODY_LIMIT },
      },
      { uid: true },
    )) {
      const uid = Number(message.uid);
      if (!Number.isFinite(uid) || uid < startUid) continue;
      const envelope = message.envelope;
      const from = envelope?.from?.[0];
      const received = message.internalDate ?? envelope?.date ?? new Date();
      const subject = (typeof envelope?.subject === 'string' && envelope.subject.trim()) || '(ohne Betreff)';
      const tooBig = (message.size ?? 0) > BODY_LIMIT || !message.source;

      let textBody: string | null = null;
      let htmlBody: string | null = null;
      let attachmentCount = 0;
      if (!tooBig && message.source) {
        const parsed = await simpleParser(message.source);
        textBody = parsed.text ?? null;
        htmlBody = parsed.html ? sanitize(parsed.html) : null;
        attachmentCount = parsed.attachments?.length ?? 0;
      }

      const snippet = tooBig
        ? 'Nachricht zu groß für die Vorschau.'
        : (textBody ?? '').replace(/\s+/g, ' ').trim().slice(0, 180);

      messages.push({
        uid,
        messageId: envelope?.messageId ?? null,
        fromAddress: from?.address ?? '',
        fromName: from?.name || null,
        subject,
        snippet,
        textBody,
        htmlBody,
        receivedAt: new Date(received).toISOString(),
        unread: !message.flags?.has('\\Seen'),
        attachmentCount,
      });
    }
    return { uidValidity, uidNext, messages };
  } finally {
    lock.release();
    await client.logout().catch(() => undefined);
  }
}

/**
 * Stored HTML is already sanitised: scripts, event handlers and foreign
 * schemes are gone. External images stay allowed in storage (the client blocks
 * them with a CSP), because stripping them here would lose the alternative.
 */
function sanitize(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'div', 'em', 'figcaption',
      'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p',
      'pre', 's', 'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot',
      'th', 'thead', 'tr', 'u', 'ul',
    ],
    allowedAttributes: {
      a: ['href', 'title'],
      img: ['src', 'alt', 'width', 'height'],
      '*': [],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'data'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
    },
  });
}