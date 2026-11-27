import nodemailer from 'nodemailer';
import type { EmailSettingsRow } from './store.ts';

export interface OutgoingMessage {
  to: string;
  toName?: string | null;
  subject: string;
  text?: string | null;
  html?: string | null;
  replyTo?: string | null;
}

export interface SendFailure {
  code: string;
  permanent: boolean;
}

/**
 * One transport per attempt: settings can change between two queued messages,
 * and a pooled connection would keep sending with the old credentials.
 */
export function createTransport(settings: EmailSettingsRow, password: string) {
  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.tls_mode === 'tls',
    requireTLS: settings.tls_mode === 'starttls',
    auth: { user: settings.username, pass: password },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 20_000,
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
  });
}

export async function sendMail(
  settings: EmailSettingsRow,
  password: string,
  message: OutgoingMessage,
): Promise<void> {
  const transport = createTransport(settings, password);
  try {
    await transport.sendMail({
      from: { name: settings.from_name, address: settings.from_address },
      to: message.toName ? { name: message.toName, address: message.to } : message.to,
      replyTo: message.replyTo ?? settings.reply_to ?? settings.from_address,
      subject: message.subject,
      text: message.text ?? undefined,
      html: message.html ?? undefined,
    });
  } finally {
    transport.close();
  }
}

/** SMTP 5xx is permanent; 4xx, TLS and network errors are worth a retry. */
export function classifySendError(error: unknown): SendFailure {
  const candidate = error as { code?: string; responseCode?: number };
  if (candidate.code === 'EAUTH') return { code: 'email_auth_failed', permanent: true };
  if (typeof candidate.responseCode === 'number' && candidate.responseCode >= 500) {
    return { code: 'email_delivery_rejected', permanent: true };
  }
  if (typeof candidate.responseCode === 'number') {
    return { code: 'email_delivery_temporary', permanent: false };
  }
  return { code: 'email_unreachable', permanent: false };
}