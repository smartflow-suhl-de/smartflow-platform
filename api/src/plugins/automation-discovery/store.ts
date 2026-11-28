import { createHash, randomBytes } from 'node:crypto';
import type { Locale, Phase } from './catalog.ts';

export type InviteStatus = 'open' | 'in_progress' | 'completed' | 'revoked' | 'expired';
export type Mode = 'short' | 'standard' | 'full';
export type AnswerSource = 'customer' | 'ai_suggested';
export type { Phase };

export interface InviteRow {
  id: string;
  tenant_id: string | null;
  customer_name: string;
  contact_email: string | null;
  locale: Locale;
  mode: Mode;
  token_hash: string;
  status: InviteStatus;
  expires_at: string;
  created_by: string;
  created_at: string;
  completed_at: string | null;
  revoked_at: string | null;
}

export interface SessionRow {
  id: string;
  invite_id: string;
  phase: Phase;
  current_step: number;
  progress: number;
  started_at: string;
  last_seen_at: string;
  completed_at: string | null;
  consent_at: string | null;
  pending_json: string | null;
  suggestions_json: string | null;
  /** How often the customer asked for the assessment; the model is costly. */
  complete_attempts: number;
  /**
   * Every model call of this invitation, hints and assessments alike. One
   * budget per link keeps a single link from spending without bound, whatever
   * route it uses.
   */
  ai_attempts: number;
}

export interface AnswerRow {
  id: string;
  session_id: string;
  question_key: string;
  value_json: string;
  source: AnswerSource;
  created_at: string;
  updated_at: string;
}

export interface ReportRow {
  id: string;
  session_id: string;
  model: string;
  summary_json: string;
  created_at: string;
}

/** A pending AI follow-up question, persisted so a reload keeps it. */
export interface PendingQuestion {
  key: string;
  prompt: string;
  cluster: string;
  ordinal: number;
}

export interface SuggestedCluster {
  id: string;
  reason?: string;
}

export interface InviteDto {
  id: string;
  tenantId: string | null;
  customerName: string;
  contactEmail: string | null;
  locale: Locale;
  mode: Mode;
  status: InviteStatus;
  expiresAt: string;
  createdAt: string;
  createdBy: string;
  completedAt: string | null;
  revokedAt: string | null;
  session: {
    id: string;
    phase: Phase;
    progress: number;
    startedAt: string;
    lastSeenAt: string;
    completedAt: string | null;
    /** Model calls this link made, and how often it asked for the assessment. */
    aiAttempts: number;
    assessmentAttempts: number;
  } | null;
  reportAvailable: boolean;
}

export function newToken(): string {
  // 32 bytes → 43 base64url characters, the 256-bit link the issue asks for.
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function nowIso(now: Date): string {
  return now.toISOString();
}

export function addDays(now: Date, days: number): string {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

export function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function toInviteDto(
  invite: InviteRow,
  session: SessionRow | null,
  reportAvailable: boolean,
): InviteDto {
  return {
    id: invite.id,
    tenantId: invite.tenant_id,
    customerName: invite.customer_name,
    contactEmail: invite.contact_email,
    locale: invite.locale,
    mode: invite.mode,
    status: invite.status,
    expiresAt: invite.expires_at,
    createdAt: invite.created_at,
    createdBy: invite.created_by,
    completedAt: invite.completed_at,
    revokedAt: invite.revoked_at,
    session: session
      ? {
          id: session.id,
          phase: session.phase,
          progress: session.progress,
          startedAt: session.started_at,
          lastSeenAt: session.last_seen_at,
          completedAt: session.completed_at,
          aiAttempts: session.ai_attempts,
          assessmentAttempts: session.complete_attempts,
        }
      : null,
    reportAvailable,
  };
}

export interface Cursor {
  created_at: string;
  id: string;
}

export function encodeCursor(row: Cursor): string {
  return Buffer.from(JSON.stringify({ created_at: row.created_at, id: row.id }), 'utf8').toString(
    'base64url',
  );
}

export function decodeCursor(value: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as Partial<Cursor>;
    if (typeof candidate.created_at !== 'string' || typeof candidate.id !== 'string') return null;
    return { created_at: candidate.created_at, id: candidate.id };
  } catch {
    return null;
  }
}
