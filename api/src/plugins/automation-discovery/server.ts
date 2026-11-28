/**
 * Automatisierungs-Scout: an operator creates a one-time link, the customer
 * walks through an AI-guided interview without a login, and the operator gets
 * a structured, schema-validated assessment.
 *
 * Trust boundaries in this file:
 * - the operator routes are platform-wide and require the operator role;
 * - the public routes carry a 256-bit token, store only its SHA-256 hash and
 *   never log the URL (route-level `logLevel: 'silent'`);
 * - the model is reached only through the llm-providers plugin, never directly.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { manifest } from './manifest.ts';
import type { PluginContext } from '../../kernel/context.ts';
import { AppError } from '../../kernel/errors.ts';
import { newId } from '../../kernel/ids.ts';
import {
  CLUSTERS,
  CLUSTERS_BY_ID,
  CONFIRM_STEPS,
  MAP_STEPS,
  MAX_TEXT_LENGTH,
  clusterIdeasStep,
  clusterSelectionStep,
  clusterSteps,
  localized,
  type Field,
  type Locale,
  type Phase,
  type StepDef,
} from './catalog.ts';
import {
  AiUnavailable,
  analyse,
  interviewHint,
  suggestClusters,
  type AnalysisReport,
  type CallInternal,
} from './ai.ts';
import {
  addDays,
  decodeCursor,
  encodeCursor,
  hashToken,
  newToken,
  nowIso,
  parseJson,
  STEP_ATTEMPT_LIMIT,
  toInviteDto,
  type AnswerRow,
  type InviteRow,
  type InviteStatus,
  type Mode,
  type PendingQuestion,
  type ReportRow,
  type SessionRow,
  type SuggestedCluster,
} from './store.ts';

const DEFAULT_EXPIRY_DAYS = 14;
const MAX_EXPIRY_DAYS = 30;
const RETENTION_DAYS = 90;
const RATE_LIMIT_PER_MINUTE = 240;
/** Coarse per-IP cap so rotating tokens cannot fill the limiter map. */
const RATE_LIMIT_IP_PER_MINUTE = 1200;
const RATE_WINDOW_MS = 60_000;
/**
 * How often one invitation may ask for an assessment. Each attempt can cost up
 * to 12 000 output tokens (4000 plus the doubled truncation retry), and a
 * failed attempt leaves the link usable, so without a counter one link could
 * spend without bound.
 */
export const COMPLETE_ATTEMPT_LIMIT = 5;
/** Slack on top of the calculated need, for retries after counted failures. */
const AI_BUDGET_SLACK = 6;
export { STEP_ATTEMPT_LIMIT };

/**
 * How many model calls one invitation may make in total, hints included.
 *
 * The assessment counter alone was not enough: `advance` asks for a hint on
 * every step and spends the same model, so a link could run hundreds of hint
 * calls without ever touching the assessment budget. This is the one budget
 * every AI path of the plugin shares. It is sized by what an honest interview
 * of that mode needs — eleven map hints, one cluster suggestion, seven deepen
 * hints per cluster, plus the assessment budget and some slack — so a real
 * customer never meets it and an abusive link stops early.
 *
 * The unit is a **logical** model call, one per reserved request of the plugin,
 * not one per HTTP request to the provider:
 *
 * - A cut-off answer is retried once inside `complete()`, so one reserved call
 *   can cost two provider calls. The worst case is therefore about twice the
 *   budget. Counting the retry separately was rejected: a legitimate retry
 *   would eat one of the customer's four attempts for the same question.
 * - A timed-out call is refunded (`isProviderOutage`) although the provider may
 *   invoice it, and a provider error that never produced an answer is refunded
 *   for the same reason. So a link can spend a little more at the provider than
 *   the budget says while it is failing, and never more while it works.
 *
 * The point of the cap is a bound on abuse by a link, and both effects keep the
 * real provider spend within a small multiple of it.
 */
export function aiAttemptLimit(mode: Mode): number {
  const clusters = mode === 'full' ? 5 : mode === 'standard' ? 3 : 0;
  const hints = 11 + (clusters > 0 ? 1 + clusters * 7 : 0);
  return hints + COMPLETE_ATTEMPT_LIMIT + AI_BUDGET_SLACK;
}
const RATE_MAX_KEYS = 5_000;
const RATE_PRUNE_INTERVAL_MS = 30_000;
/** The one answer key that is not part of a question definition. */
const CONSENT_KEY = 'consent';

interface PublicStep {
  key: string;
  phase: Phase;
  fields: Array<{
    key: string;
    kind: Field['kind'];
    label: { de: string; en: string };
    help?: { de: string; en: string };
    required: boolean;
    maxLength?: number;
    min?: number;
    max?: number;
    minSelections?: number;
    maxSelections?: number;
    options?: Array<{ value: string; label: { de: string; en: string } }>;
  }>;
  pending: boolean;
}

interface PublicState {
  status: InviteStatus;
  locale: Locale;
  customerName: string;
  mode: Mode;
  expiresAt: string;
  phase: Phase;
  stepIndex: number;
  progress: number;
  step: PublicStep | null;
  answers: Record<string, unknown>;
  clusters: {
    suggested: Array<SuggestedCluster & { label: { de: string; en: string } }>;
    selected: string[];
  } | null;
  ideas: Array<{ id: string; title: string; why: string | null }>;
  canComplete: boolean;
  completedAt: string | null;
  report: AnalysisReport | null;
}

function stepToPublic(
  step: StepDef,
  options?: Array<{ value: string; label: { de: string; en: string } }>,
): PublicStep {
  return {
    key: step.key,
    phase: step.phase,
    pending: false,
    fields: step.fields.map((field) => ({
      key: field.key,
      kind: field.kind,
      label: field.label,
      ...(field.help ? { help: field.help } : {}),
      required: field.required,
      ...(field.maxLength === undefined
        ? {}
        : { maxLength: Math.min(field.maxLength, MAX_TEXT_LENGTH) }),
      ...(field.min === undefined ? {} : { min: field.min }),
      ...(field.max === undefined ? {} : { max: field.max }),
      ...(field.minSelections === undefined ? {} : { minSelections: field.minSelections }),
      ...(field.maxSelections === undefined ? {} : { maxSelections: field.maxSelections }),
      ...((options ?? field.options) ? { options: options ?? field.options } : {}),
    })),
  };
}

function pendingToPublic(pending: PendingQuestion): PublicStep {
  return {
    key: pending.key,
    phase: 'deepen',
    pending: true,
    fields: [
      {
        key: pending.key,
        kind: 'text',
        required: true,
        maxLength: MAX_TEXT_LENGTH,
        label: { de: pending.prompt, en: pending.prompt },
      },
    ],
  };
}

function selectedClustersOf(answers: Map<string, unknown>): string[] {
  const raw = answers.get('clusters.selected');
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (value): value is string => typeof value === 'string' && CLUSTERS_BY_ID.has(value),
  );
}

/** The flatten order of the deepen phase: seven questions then the idea card per cluster. */
function deepenSteps(
  clusters: string[],
): Array<{ step: StepDef; cluster: string; isIdeas: boolean }> {
  const steps: Array<{ step: StepDef; cluster: string; isIdeas: boolean }> = [];
  for (const cluster of clusters) {
    for (const step of clusterSteps(cluster)) steps.push({ step, cluster, isIdeas: false });
    steps.push({ step: clusterIdeasStep(cluster), cluster, isIdeas: true });
  }
  return steps;
}

function totalSteps(mode: Mode, clusters: number, shortcut: boolean): number {
  const confirm = CONFIRM_STEPS.length;
  if (shortcut || mode === 'short') return 1 + 12 + confirm;
  const deepen = clusters === 0 ? 0 : clusters * 8;
  return 1 + 12 + 1 + deepen + confirm;
}

function progressOf(phase: Phase, stepIndex: number, total: number): number {
  if (total <= 0) return 0;
  const doneByPhase: Record<Phase, number> = {
    consent: 0,
    map: 1,
    clusters: 1 + 12,
    deepen: 1 + 12 + 1,
    confirm: Math.max(0, total - 3),
  };
  const done = doneByPhase[phase] + stepIndex;
  return Math.min(99, Math.round((done / total) * 100));
}

function answerMap(rows: AnswerRow[]): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const row of rows) {
    const parsed = parseJson<unknown>(row.value_json);
    if (parsed !== null) map.set(row.question_key, parsed);
  }
  return map;
}

function answerRows(db: PluginContext['db'], sessionId: string): AnswerRow[] {
  return db
    .prepare(
      'select * from discovery_answer where session_id = ? order by created_at, question_key',
    )
    .all(sessionId) as AnswerRow[];
}

function findInviteByToken(db: PluginContext['db'], token: string): InviteRow | null {
  const hash = hashToken(token);
  const row = db.prepare('select * from discovery_invite where token_hash = ?').get(hash) as
    InviteRow | undefined;
  return row ?? null;
}

function findSession(db: PluginContext['db'], inviteId: string): SessionRow | null {
  const row = db
    .prepare('select * from discovery_session where invite_id = ? order by started_at desc limit 1')
    .get(inviteId) as SessionRow | undefined;
  return row ?? null;
}

function findReport(db: PluginContext['db'], sessionId: string): ReportRow | null {
  const row = db
    .prepare('select * from discovery_report where session_id = ? order by created_at desc limit 1')
    .get(sessionId) as ReportRow | undefined;
  return row ?? null;
}

function reportOf(row: ReportRow): AnalysisReport | null {
  return parseJson<AnalysisReport>(row.summary_json);
}

function requireInvite(db: PluginContext['db'], id: string): InviteRow {
  const row = db.prepare('select * from discovery_invite where id = ?').get(id) as
    InviteRow | undefined;
  if (!row) throw new AppError('discovery_invite_not_found', 'Invitation not found.', 404);
  return row;
}

function markExpiredIfNeeded(
  db: PluginContext['db'],
  invite: InviteRow,
  now: Date,
  persist: boolean,
): boolean {
  if (invite.status === 'completed' || invite.status === 'revoked') return false;
  if (new Date(invite.expires_at).getTime() > now.getTime()) return false;
  if (persist) {
    db.prepare(
      "update discovery_invite set status = 'expired' where id = ? and status in ('open','in_progress')",
    ).run(invite.id);
  }
  invite.status = 'expired';
  return true;
}

/** Persists expiry before status counts or filters, so old rows cannot stay "open". */
function expireStale(db: PluginContext['db'], clock: Date): void {
  db.prepare(
    "update discovery_invite set status = 'expired' where expires_at < ? and status in ('open','in_progress')",
  ).run(clock.toISOString());
}

function responseHeaders(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('x-robots-tag', 'noindex, nofollow');
  reply.header('x-content-type-options', 'nosniff');
}

const tokenParams = {
  type: 'object',
  additionalProperties: false,
  required: ['token'],
  properties: {
    token: { type: 'string', minLength: 20, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' },
  },
} as const;

const answersBody = {
  type: 'object',
  additionalProperties: false,
  required: ['answers'],
  properties: {
    answers: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'value'],
        properties: {
          key: { type: 'string', minLength: 1, maxLength: 120 },
          value: {},
        },
      },
    },
  },
} as const;

const advanceBody = {
  type: 'object',
  additionalProperties: false,
  properties: { shortcut: { type: 'boolean' } },
} as const;

const contactBody = {
  type: 'object',
  additionalProperties: false,
  required: ['wanted'],
  properties: {
    wanted: { type: 'boolean' },
    way: { type: 'string', maxLength: 300 },
  },
} as const;

const inviteBody = {
  type: 'object',
  additionalProperties: false,
  required: ['customerName'],
  properties: {
    customerName: { type: 'string', minLength: 2, maxLength: 120 },
    contactEmail: { type: 'string', maxLength: 200 },
    locale: { type: 'string', enum: ['de', 'en'] },
    mode: { type: 'string', enum: ['short', 'standard', 'full'] },
    expiresInDays: { type: 'integer', minimum: 1, maximum: MAX_EXPIRY_DAYS },
    tenantId: { type: 'string', maxLength: 80 },
  },
} as const;

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: {
      type: 'string',
      enum: ['open', 'in_progress', 'completed', 'revoked', 'expired'],
    },
    q: { type: 'string', maxLength: 100 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
    cursor: { type: 'string', maxLength: 400 },
  },
} as const;

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Field-level validation against the catalogue. Throws 422 with stable keys. */
function validateFields(fields: Field[], input: Record<string, unknown>): Record<string, unknown> {
  const errors: Record<string, string> = {};
  const output: Record<string, unknown> = {};

  for (const field of fields) {
    const has = Object.prototype.hasOwnProperty.call(input, field.key);
    const value = input[field.key];
    if (!has || value === undefined || value === null || value === '') {
      if (field.required) errors[field.key] = 'This answer is required.';
      continue;
    }
    switch (field.kind) {
      case 'text': {
        if (typeof value !== 'string') {
          errors[field.key] = 'Please enter text.';
          break;
        }
        const text = value.trim();
        const limit = Math.min(field.maxLength ?? MAX_TEXT_LENGTH, MAX_TEXT_LENGTH);
        if (text.length > limit) {
          errors[field.key] = `Please use at most ${limit} characters.`;
          break;
        }
        if (field.required && text.length === 0) {
          errors[field.key] = 'This answer is required.';
          break;
        }
        output[field.key] = text;
        break;
      }
      case 'single':
      case 'scale': {
        if (typeof value !== 'string' || !field.options?.some((option) => option.value === value)) {
          errors[field.key] = 'Please choose one of the options.';
          break;
        }
        output[field.key] = value;
        break;
      }
      case 'multi': {
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
          errors[field.key] = 'Please choose from the options.';
          break;
        }
        const list = [...new Set(value as string[])];
        const allowed = new Set((field.options ?? []).map((option) => option.value));
        if (
          list.some((entry) => field.options && field.options.length > 0 && !allowed.has(entry))
        ) {
          errors[field.key] = 'Please choose from the options.';
          break;
        }
        if (field.minSelections !== undefined && list.length < field.minSelections) {
          errors[field.key] = `Please choose at least ${field.minSelections}.`;
          break;
        }
        const max = field.maxSelections ?? 12;
        if (list.length > max) {
          errors[field.key] = `Please choose at most ${max}.`;
          break;
        }
        output[field.key] = list;
        break;
      }
      case 'rank': {
        const allowed = (field.options ?? []).map((option) => option.value);
        if (
          !Array.isArray(value) ||
          value.length !== allowed.length ||
          value.some((entry) => typeof entry !== 'string' || !allowed.includes(entry)) ||
          new Set(value).size !== allowed.length
        ) {
          errors[field.key] = 'Please put every option in order.';
          break;
        }
        output[field.key] = value;
        break;
      }
      case 'number': {
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          errors[field.key] = 'Please enter a whole number.';
          break;
        }
        if (field.min !== undefined && value < field.min) {
          errors[field.key] = `Please enter at least ${field.min}.`;
          break;
        }
        if (field.max !== undefined && value > field.max) {
          errors[field.key] = `Please enter at most ${field.max}.`;
          break;
        }
        output[field.key] = value;
        break;
      }
      case 'yesno': {
        if (typeof value !== 'boolean') {
          errors[field.key] = 'Please answer yes or no.';
          break;
        }
        output[field.key] = value;
        break;
      }
      default:
        errors[field.key] = 'Unsupported answer type.';
    }
  }

  if (Object.keys(errors).length > 0) {
    throw new AppError('validation_failed', 'Please check the highlighted fields.', 422, {
      fields: errors,
    });
  }
  return output;
}

function aiError(error: unknown): AppError {
  if (error instanceof AiUnavailable) {
    if (error.reason === 'truncated') {
      // A budget problem on our side, not a malformed model answer: the
      // customer gets a precise, retryable message instead of a schema error.
      return new AppError(
        'discovery_ai_truncated',
        'The AI answer was cut off before it was complete. Please try again.',
        502,
        { reason: error.reason },
      );
    }
    if (error.reason === 'filtered') {
      // The provider's filter stopped the answer; asking again cannot help.
      return new AppError(
        'discovery_ai_filtered',
        'The AI provider refused to answer this request.',
        422,
        { reason: error.reason },
      );
    }
    if (error.reason === 'invalid_output') {
      return new AppError(
        'discovery_analysis_invalid',
        'The AI result did not match the required schema.',
        502,
        { reason: error.reason },
      );
    }
    return new AppError('discovery_ai_unavailable', 'The AI service is not available.', 503, {
      reason: error.reason,
    });
  }
  return new AppError('discovery_ai_unavailable', 'The AI service is not available.', 503);
}

/**
 * Sliding-window limiter with a hard key cap and a timed prune.
 *
 * The public route keys by a hash of a customer-chosen token, so the key space
 * is unbounded. Insertion order doubles as LRU order: a hit moves the key to
 * the end and the oldest key is evicted above `maxKeys`. Expired keys are swept
 * on an interval, not on every request.
 */
export class PublicRateLimiter {
  readonly #windows = new Map<string, number[]>();
  #lastPrune = 0;

  constructor(
    private readonly maxKeys = RATE_MAX_KEYS,
    private readonly pruneIntervalMs = RATE_PRUNE_INTERVAL_MS,
  ) {}

  get size(): number {
    return this.#windows.size;
  }

  clear(): void {
    this.#windows.clear();
    this.#lastPrune = 0;
  }

  allow(key: string, limit: number, nowMs: number): boolean {
    this.#prune(nowMs);
    const recent = (this.#windows.get(key) ?? []).filter((stamp) => nowMs - stamp < RATE_WINDOW_MS);
    if (recent.length >= limit) {
      this.#touch(key, recent);
      return false;
    }
    recent.push(nowMs);
    this.#touch(key, recent);
    return true;
  }

  #touch(key: string, stamps: number[]): void {
    this.#windows.delete(key);
    this.#windows.set(key, stamps);
    while (this.#windows.size > this.maxKeys) {
      const oldest = this.#windows.keys().next().value;
      if (oldest === undefined) break;
      this.#windows.delete(oldest);
    }
  }

  #prune(nowMs: number): void {
    if (nowMs - this.#lastPrune < this.pruneIntervalMs) return;
    this.#lastPrune = nowMs;
    const cutoff = nowMs - RATE_WINDOW_MS;
    for (const [key, stamps] of this.#windows) {
      if (stamps.every((stamp) => stamp < cutoff)) this.#windows.delete(key);
    }
  }
}

export const publicRateLimiter = new PublicRateLimiter();

function publicRateLimit(): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    responseHeaders(reply);
    const now = Date.now();
    // The coarse IP cap runs first: a rotating token must not insert a new
    // bucket and evict someone else's before the IP limit can refuse it.
    if (!publicRateLimiter.allow(`ip:${request.ip}`, RATE_LIMIT_IP_PER_MINUTE, now)) {
      reply.header('retry-after', '60');
      throw new AppError('rate_limited', 'Too many requests. Please wait a moment.', 429);
    }
    const token = (request.params as { token?: string } | undefined)?.token ?? '';
    const hash = hashToken(token).slice(0, 16);
    const key = `${hash}:${request.ip}`;
    if (!publicRateLimiter.allow(key, RATE_LIMIT_PER_MINUTE, now)) {
      reply.header('retry-after', '60');
      throw new AppError('rate_limited', 'Too many requests. Please wait a moment.', 429);
    }
  };
}

export function register(ctx: PluginContext): void {
  const { app, db, log, now, config } = ctx;

  ctx.migrate([
    {
      version: 1,
      up(database) {
        database.exec(`
          create table discovery_invite (
            id text primary key,
            tenant_id text,
            customer_name text not null,
            contact_email text,
            locale text not null check (locale in ('de','en')),
            mode text not null check (mode in ('short','standard','full')),
            token_hash text not null unique,
            status text not null check (status in ('open','in_progress','completed','revoked','expired')),
            expires_at text not null,
            created_by text not null,
            created_at text not null,
            completed_at text,
            revoked_at text
          );
          create index discovery_invite_created on discovery_invite(created_at, id);
          create index discovery_invite_status on discovery_invite(status, created_at);

          create table discovery_session (
            id text primary key,
            invite_id text not null unique references discovery_invite(id) on delete cascade,
            phase text not null,
            current_step integer not null default 0,
            progress integer not null default 0,
            started_at text not null,
            last_seen_at text not null,
            completed_at text,
            consent_at text,
            pending_json text,
            suggestions_json text
          );

          create table discovery_answer (
            id text primary key,
            session_id text not null references discovery_session(id) on delete cascade,
            question_key text not null,
            value_json text not null,
            source text not null check (source in ('customer','ai_suggested')),
            created_at text not null,
            updated_at text not null,
            unique (session_id, question_key)
          );

          create table discovery_report (
            id text primary key,
            session_id text not null references discovery_session(id) on delete cascade,
            model text not null,
            summary_json text not null,
            created_at text not null
          );
          create index discovery_report_session on discovery_report(session_id);
        `);
      },
    },
    {
      version: 2,
      up(database) {
        // A racing second complete could insert a second report. Keep the
        // oldest row per session and make the session the unique key.
        database.exec(`
          delete from discovery_report
           where rowid not in (select min(rowid) from discovery_report group by session_id);
          drop index if exists discovery_report_session;
          create unique index discovery_report_session on discovery_report(session_id);
        `);
      },
    },
    {
      version: 3,
      up(database) {
        // Every assessment request costs model tokens, and a failed one leaves
        // the link open. The counter is per session, so one link cannot spend
        // without bound.
        database.exec(
          'alter table discovery_session add column complete_attempts integer not null default 0',
        );
      },
    },
    {
      version: 4,
      up(database) {
        // One budget for every model call of a link, hints included, plus a
        // per-step counter so one question cannot drain it on its own. The
        // assessment counter alone left the much cheaper hint route unmetered.
        database.exec(`
          alter table discovery_session add column ai_attempts integer not null default 0;
          alter table discovery_session add column ai_step_key text;
          alter table discovery_session add column ai_step_attempts integer not null default 0;
        `);
      },
    },
  ]);

  const call: CallInternal = (caller, request) => ctx.callInternal(caller, request);

  // Every documented operation needs a summary (the API-first rule in the
  // health test). Keeping the map next to the routes avoids repeating the same
  // option object twelve times and cannot drift silently: a missing entry is
  // caught by the kernel test.
  const SUMMARIES: Record<string, string> = {
    'GET /discovery/overview': 'Count invitations and list recent activity',
    'GET /discovery/invites': 'List invitations with keyset pagination',
    'POST /discovery/invites': 'Create an invitation and return its link once',
    'GET /discovery/invites/:id': 'Read one invitation with answers and report',
    'POST /discovery/invites/:id/revoke': 'Revoke an invitation immediately',
    'POST /discovery/invites/:id/resend': 'Rotate the link of an open invitation',
    'GET /discovery/invites/:id/report': 'Read the validated assessment of an invitation',
    'GET /discovery/public/:token': 'Read the public interview state for a link',
    'POST /discovery/public/:token/answers': 'Save public interview answers idempotently',
    'POST /discovery/public/:token/advance':
      'Advance the public interview and ask the AI for a hint',
    'POST /discovery/public/:token/contact': 'Store the contact wish of the customer',
    'POST /discovery/public/:token/complete': 'Complete the interview and create the assessment',
  };

  app.addHook('onRoute', (route) => {
    const url = route.url.replace(/^\/api\/v1/, '');
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      const summary = SUMMARIES[`${method} ${url}`];
      if (!summary) continue;
      route.schema = { ...(route.schema ?? {}), tags: ['discovery'], summary };
    }
  });

  function purgeOld(clock: Date): void {
    const cutoff = new Date(clock.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const stale = db
      .prepare(
        `select id from discovery_invite
         where (completed_at is not null and completed_at < ?)
            or (revoked_at is not null and revoked_at < ?)
            or (expires_at < ?)`,
      )
      .all(cutoff, cutoff, cutoff) as Array<{ id: string }>;
    if (stale.length === 0) return;
    const remove = db.transaction((rows: Array<{ id: string }>) => {
      for (const row of rows) {
        db.prepare(
          'delete from discovery_report where session_id in (select id from discovery_session where invite_id = ?)',
        ).run(row.id);
        db.prepare(
          'delete from discovery_answer where session_id in (select id from discovery_session where invite_id = ?)',
        ).run(row.id);
        db.prepare('delete from discovery_session where invite_id = ?').run(row.id);
        db.prepare('delete from discovery_invite where id = ?').run(row.id);
      }
    });
    remove(stale);
  }

  purgeOld(now());

  function answerLabel(questionKey: string): string {
    for (const step of MAP_STEPS) {
      const field = step.fields.find((entry) => entry.key === questionKey);
      if (field) return field.label.de;
    }
    for (const step of CONFIRM_STEPS) {
      const field = step.fields.find((entry) => entry.key === questionKey);
      if (field) return field.label.de;
    }
    if (questionKey.startsWith('deep.')) {
      const parts = questionKey.split('.');
      const cluster = parts[1] ?? '';
      const rest = parts.slice(2).join('.');
      for (const step of clusterSteps(cluster)) {
        const field = step.fields[0];
        if (field && field.key === questionKey) return field.label.de;
      }
      if (rest === 'ideas.relevant') return `Relevante Ideen (Thema ${cluster})`;
      if (rest.startsWith('fu')) return `Nachfrage (Thema ${cluster})`;
    }
    if (questionKey === 'clusters.selected') return 'Gewählte Themen';
    return questionKey;
  }

  function answerText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map((entry) => String(entry)).join(', ');
    return JSON.stringify(value) ?? String(value);
  }

  function interviewHistory(
    answers: Map<string, unknown>,
  ): Array<{ question: string; answer: string }> {
    const history: Array<{ question: string; answer: string }> = [];
    for (const [key, value] of answers) {
      if (key === CONSENT_KEY) continue;
      const text = answerText(value).trim();
      if (text.length === 0) continue;
      history.push({ question: answerLabel(key), answer: text });
    }
    return history;
  }

  function selectedClusterIds(answers: Map<string, unknown>): string[] {
    return selectedClustersOf(answers);
  }

  function currentStepOf(
    session: SessionRow,
    answers: Map<string, unknown>,
  ): { step: StepDef | null; pending: PendingQuestion | null } {
    const pending = parseJson<PendingQuestion>(session.pending_json);
    if (pending) return { step: null, pending };

    if (session.phase === 'consent') {
      return { step: MAP_STEPS[0] ?? null, pending: null };
    }
    if (session.phase === 'map') {
      return { step: MAP_STEPS[session.current_step + 1] ?? null, pending: null };
    }
    if (session.phase === 'clusters') {
      return { step: clusterSelectionStep(), pending: null };
    }
    if (session.phase === 'deepen') {
      const clusters = selectedClusterIds(answers);
      const steps = deepenSteps(clusters);
      const entry = steps[session.current_step];
      return { step: entry ? entry.step : null, pending: null };
    }
    if (session.phase === 'confirm') {
      return { step: CONFIRM_STEPS[session.current_step] ?? null, pending: null };
    }
    return { step: null, pending: null };
  }

  function ideasOf(
    answers: Map<string, unknown>,
    cluster: string,
  ): Array<{ id: string; title: string; why: string | null }> {
    const raw = answers.get(`deep.${cluster}.ideas.catalog`);
    if (!Array.isArray(raw)) return [];
    const ideas: Array<{ id: string; title: string; why: string | null }> = [];
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as { id?: unknown; title?: unknown; why?: unknown };
      if (typeof record.id !== 'string' || typeof record.title !== 'string') continue;
      ideas.push({
        id: record.id,
        title: record.title,
        why: typeof record.why === 'string' ? record.why : null,
      });
    }
    return ideas;
  }

  function buildPublicState(
    invite: InviteRow,
    session: SessionRow | null,
    answers: Map<string, unknown>,
    _report: AnalysisReport | null,
  ): PublicState {
    const phase: Phase = session ? session.phase : 'consent';
    const stepIndex = session ? session.current_step : 0;
    const clusters = session ? selectedClusterIds(answers) : [];
    const shortcut = answers.get('meta.shortcut') === true;
    const total = totalSteps(invite.mode, clusters.length, shortcut);
    const current = session
      ? currentStepOf(session, answers)
      : { step: MAP_STEPS[0] ?? null, pending: null };

    let step: PublicStep | null = null;
    let ideas: Array<{ id: string; title: string; why: string | null }> = [];
    if (current.pending) {
      step = pendingToPublic(current.pending);
    } else if (current.step) {
      if (current.step.phase === 'deepen' && current.step.cluster) {
        ideas = ideasOf(answers, current.step.cluster);
        if (current.step.key.endsWith('.ideas')) {
          step = stepToPublic(
            current.step,
            ideas.map((idea) => ({
              value: idea.id,
              label: { de: idea.title, en: idea.title },
            })),
          );
        } else {
          step = stepToPublic(current.step);
        }
      } else if (current.step.key === 'clusters.selected') {
        const suggested = parseJson<SuggestedCluster[]>(session?.suggestions_json ?? null) ?? [];
        step = stepToPublic(
          current.step,
          CLUSTERS.map((cluster) => ({
            value: cluster.id,
            label: {
              de: `${cluster.label.de} — ${cluster.description.de}`,
              en: `${cluster.label.en} — ${cluster.description.en}`,
            },
          })),
        );
        return {
          status: invite.status,
          locale: invite.locale,
          customerName: invite.customer_name,
          mode: invite.mode,
          expiresAt: invite.expires_at,
          phase,
          stepIndex,
          progress: progressOf(phase, stepIndex, total),
          step,
          answers: Object.fromEntries(answers),
          clusters: {
            suggested: suggested.map((entry) => ({
              ...entry,
              label: CLUSTERS_BY_ID.get(entry.id)?.label ?? { de: entry.id, en: entry.id },
            })),
            selected: clusters,
          },
          ideas: [],
          canComplete: false,
          completedAt: invite.completed_at,
          report: null,
        };
      } else if (current.step.key === 'confirm.priority') {
        const options = clusters.map((id) => {
          const cluster = CLUSTERS_BY_ID.get(id);
          return {
            value: id,
            label: cluster?.label ?? { de: id, en: id },
          };
        });
        step = stepToPublic({
          ...current.step,
          fields: current.step.fields.map((field) => ({ ...field, options })),
        });
      } else {
        step = stepToPublic(current.step);
      }
    }

    return {
      status: invite.status,
      locale: invite.locale,
      customerName: invite.customer_name,
      mode: invite.mode,
      expiresAt: invite.expires_at,
      phase,
      stepIndex,
      progress: progressOf(phase, stepIndex, total),
      step,
      answers: Object.fromEntries(answers),
      clusters:
        session && (phase === 'clusters' || phase === 'deepen')
          ? {
              suggested: (parseJson<SuggestedCluster[]>(session.suggestions_json) ?? []).map(
                (entry) => ({
                  ...entry,
                  label: CLUSTERS_BY_ID.get(entry.id)?.label ?? { de: entry.id, en: entry.id },
                }),
              ),
              selected: clusters,
            }
          : null,
      ideas,
      canComplete: Boolean(
        session && session.phase === 'confirm' && session.current_step >= CONFIRM_STEPS.length,
      ),
      completedAt: invite.completed_at,
      report: null,
    };
  }

  function openInviteByToken(token: string): { invite: InviteRow; session: SessionRow | null } {
    const invite = findInviteByToken(db, token);
    if (!invite) throw new AppError('discovery_invite_not_found', 'This link is not valid.', 404);
    markExpiredIfNeeded(db, invite, now(), true);
    if (invite.status === 'revoked') {
      throw new AppError('discovery_link_revoked', 'This link was revoked.', 410);
    }
    if (invite.status === 'expired') {
      throw new AppError('discovery_link_expired', 'This link has expired.', 410);
    }
    const session = findSession(db, invite.id);
    return { invite, session };
  }

  function completedPayload(invite: InviteRow, session: SessionRow | null): PublicState {
    const rows = session ? answerRows(db, session.id) : [];
    const reportRow = session ? findReport(db, session.id) : null;
    const base = buildPublicState(
      invite,
      session,
      answerMap(rows),
      reportRow ? reportOf(reportRow) : null,
    );
    return {
      ...base,
      // The completed link stays minimal: the customer sees the result, not a
      // replay of every raw answer.
      answers: {},
      step: null,
      canComplete: false,
      progress: 100,
      report: reportRow ? reportOf(reportRow) : null,
    };
  }

  function requireEditable(invite: InviteRow): void {
    if (invite.status === 'completed') {
      throw new AppError('discovery_link_completed', 'This interview is already completed.', 409);
    }
    if (invite.status === 'revoked') {
      throw new AppError('discovery_link_revoked', 'This link was revoked.', 410);
    }
    if (invite.status === 'expired') {
      throw new AppError('discovery_link_expired', 'This link has expired.', 410);
    }
  }

  function ensureSession(invite: InviteRow): SessionRow {
    const existing = findSession(db, invite.id);
    if (existing) {
      db.prepare('update discovery_session set last_seen_at = ? where id = ?').run(
        nowIso(now()),
        existing.id,
      );
      existing.last_seen_at = nowIso(now());
      return existing;
    }
    const stamp = nowIso(now());
    const session: SessionRow = {
      id: newId('dsc'),
      invite_id: invite.id,
      phase: 'consent',
      current_step: 0,
      progress: 0,
      started_at: stamp,
      last_seen_at: stamp,
      completed_at: null,
      consent_at: null,
      pending_json: null,
      suggestions_json: null,
      complete_attempts: 0,
      ai_attempts: 0,
      ai_step_key: null,
      ai_step_attempts: 0,
    };
    db.prepare(
      `insert into discovery_session
       (id, invite_id, phase, current_step, progress, started_at, last_seen_at, completed_at, consent_at, pending_json, suggestions_json)
       values (?, ?, ?, ?, ?, ?, ?, null, null, null, null)`,
    ).run(
      session.id,
      session.invite_id,
      session.phase,
      session.current_step,
      session.progress,
      session.started_at,
      session.last_seen_at,
    );
    if (invite.status === 'open') {
      db.prepare("update discovery_invite set status = 'in_progress' where id = ?").run(invite.id);
      invite.status = 'in_progress';
    }
    return session;
  }

  function saveAnswers(
    sessionId: string,
    entries: Array<{ key: string; value: unknown }>,
    source: 'customer' | 'ai_suggested',
  ): void {
    const stamp = nowIso(now());
    const upsert = db.prepare(
      `insert into discovery_answer (id, session_id, question_key, value_json, source, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict(session_id, question_key) do update set
         value_json = excluded.value_json,
         source = excluded.source,
         updated_at = excluded.updated_at`,
    );
    const transaction = db.transaction((rows: Array<{ key: string; value: unknown }>) => {
      for (const row of rows) {
        upsert.run(
          newId('ans'),
          sessionId,
          row.key,
          JSON.stringify(row.value),
          source,
          stamp,
          stamp,
        );
      }
    });
    transaction(entries);
  }

  function expectedFields(session: SessionRow, answers: Map<string, unknown>): Field[] {
    const current = currentStepOf(session, answers);
    if (current.pending) {
      return [
        {
          key: current.pending.key,
          kind: 'text',
          required: true,
          maxLength: MAX_TEXT_LENGTH,
          label: { de: current.pending.prompt, en: current.pending.prompt },
        },
      ];
    }
    if (!current.step) return [];
    if (current.step.key === 'confirm.priority') {
      const clusters = selectedClusterIds(answers);
      return current.step.fields.map((field) => ({
        ...field,
        options: clusters.map((id) => ({
          value: id,
          label: CLUSTERS_BY_ID.get(id)?.label ?? { de: id, en: id },
        })),
      }));
    }
    if (current.step.key === 'clusters.selected') {
      const max = 5;
      return current.step.fields.map((field) => ({
        ...field,
        maxSelections: Math.min(field.maxSelections ?? max, max),
      }));
    }
    if (current.step.key.endsWith('.ideas')) {
      const cluster = current.step.cluster ?? '';
      const ideas = ideasOf(answers, cluster);
      return [
        {
          key: `deep.${cluster}.ideas.relevant`,
          kind: 'multi',
          required: false,
          maxSelections: 3,
          options: ideas.map((idea) => ({
            value: idea.id,
            label: { de: idea.title, en: idea.title },
          })),
          label: { de: 'Relevante Vorschläge', en: 'Relevant suggestions' },
        },
      ];
    }
    return current.step.fields;
  }

  function assertClusterLimit(mode: Mode, count: number): void {
    const max = mode === 'full' ? 5 : 3;
    if (count > max) {
      throw new AppError('validation_failed', 'Please check the highlighted fields.', 422, {
        fields: { 'clusters.selected': `Please choose at most ${max}.` },
      });
    }
  }

  /** The error every metered route throws once the link's AI budget is used up. */
  function aiLimitReached(invite: InviteRow, session: SessionRow, used: number): AppError {
    log.warn(
      { inviteId: invite.id, sessionId: session.id, used, limit: aiAttemptLimit(invite.mode) },
      'discovery ai budget refused: attempt limit reached',
    );
    session.ai_attempts = used;
    return new AppError(
      'discovery_complete_limit_reached',
      'This link has used up the AI budget for this interview.',
      429,
    );
  }

  /**
   * Counts one logical model call against the link's budget before it happens.
   *
   * Both checks and both counters move inside one synchronous transaction, so
   * no second request can pass the check in between and the limits hold. A
   * refusal changes nothing: the caller gets 429 and no model is called.
   *
   * `stepKey` identifies the question being served. Calls for the same step add
   * up in `ai_step_attempts`, a different step starts that counter over. The
   * assessment passes `perStep: false`: it has its own `COMPLETE_ATTEMPT_LIMIT`
   * and repeating it after a counted failure is legitimate, so it must not
   * write the question counter.
   */
  function reserveAiAttempt(
    invite: InviteRow,
    session: SessionRow,
    stepKey: string,
    perStep = true,
  ): void {
    const budget = aiAttemptLimit(invite.mode);
    const claim = db.transaction((): 'ok' | 'budget' | 'step' => {
      const row = db
        .prepare(
          'select ai_attempts, ai_step_key, ai_step_attempts from discovery_session where id = ?',
        )
        .get(session.id) as
        { ai_attempts: number; ai_step_key: string | null; ai_step_attempts: number } | undefined;
      if (!row) return 'budget';
      if (row.ai_attempts >= budget) return 'budget';
      const sameStep = row.ai_step_key === stepKey;
      if (perStep && sameStep && row.ai_step_attempts >= STEP_ATTEMPT_LIMIT) return 'step';
      if (!perStep) {
        db.prepare('update discovery_session set ai_attempts = ai_attempts + 1 where id = ?').run(
          session.id,
        );
        return 'ok';
      }
      db.prepare(
        `update discovery_session
            set ai_attempts = ai_attempts + 1,
                ai_step_key = ?,
                ai_step_attempts = ?
          where id = ?`,
      ).run(stepKey, sameStep ? row.ai_step_attempts + 1 : 1, session.id);
      return 'ok';
    });
    const verdict = claim();
    if (verdict === 'budget') throw aiLimitReached(invite, session, budget);
    if (verdict === 'step') {
      log.warn(
        {
          inviteId: invite.id,
          sessionId: session.id,
          step: stepKey,
          limit: STEP_ATTEMPT_LIMIT,
        },
        'discovery ai budget refused: this step asked the model too often',
      );
      throw new AppError(
        'discovery_complete_limit_reached',
        'This step asked the AI too often. Please contact the person who invited you.',
        429,
      );
    }
    session.ai_attempts += 1;
  }

  /**
   * Gives a reserved attempt back after a provider outage.
   *
   * The link's total budget always comes back. The step counter comes back too
   * when the outage happened on the step it currently belongs to, so four
   * provider hiccups on one question cannot lock that question for good: no
   * call succeeded, so nothing was spent. `stepKey` must be the key that was
   * reserved, otherwise a late response cannot touch another step's counter.
   *
   * Hard failures (`truncated`, `invalid_output`, `filtered`) do not come
   * through here: those reached the model and the step counter keeps counting
   * them, so a link cannot buy an unlimited number of paid answers by looping
   * the same question.
   */
  function releaseAiAttempt(session: SessionRow, stepKey: string): void {
    const refund = db.transaction(() => {
      db.prepare(
        'update discovery_session set ai_attempts = ai_attempts - 1 where id = ? and ai_attempts > 0',
      ).run(session.id);
      db.prepare(
        `update discovery_session
            set ai_step_attempts = ai_step_attempts - 1
          where id = ? and ai_step_key = ? and ai_step_attempts > 0`,
      ).run(session.id, stepKey);
      return db
        .prepare(
          'select ai_attempts, ai_step_key, ai_step_attempts from discovery_session where id = ?',
        )
        .get(session.id) as
        { ai_attempts: number; ai_step_key: string | null; ai_step_attempts: number } | undefined;
    });
    const row = refund();
    session.ai_attempts = row?.ai_attempts ?? Math.max(0, session.ai_attempts - 1);
  }

  /**
   * Closes a successful, paid model call for that step.
   *
   * The answers arrived, so the question is done with its allowance: a later
   * return to the same step (a revisit in the deep phase, or `deepen` coming
   * back to it) starts with a full `STEP_ATTEMPT_LIMIT` again instead of
   * inheriting the old count and blocking a customer who did nothing wrong.
   */
  function finishAiAttempt(session: SessionRow, stepKey: string): void {
    db.prepare(
      `update discovery_session
          set ai_step_key = null, ai_step_attempts = 0
        where id = ? and ai_step_key = ?`,
    ).run(session.id, stepKey);
  }

  /**
   * Did the provider fail, rather than the conversation?
   *
   * These are outages on our side: the customer's answers are fine, the model
   * was down, rate limited or too slow. They must not cost the link its token
   * budget, otherwise five provider hiccups lock a paying customer out for
   * good. `truncated`, `invalid_output` and `filtered` did reach the model and
   * cost tokens, so they stay counted.
   *
   * An outage also gives the question its attempt back, but only through
   * `releaseAiAttempt` and only when the reservation actually belongs to that
   * question: no answer arrived, so nothing was spent. Counted failures
   * (`truncated`, `invalid_output`, `filtered`) keep the question counter, which
   * is what stops a loop on a question the model cannot answer.
   */
  function isProviderOutage(error: unknown): boolean {
    return (
      error instanceof AiUnavailable &&
      (error.reason === 'not_configured' ||
        error.reason === 'caller_not_allowed' ||
        error.reason === 'unavailable' ||
        error.reason === 'timeout')
    );
  }

  async function advance(
    invite: InviteRow,
    session: SessionRow,
    body: { shortcut?: boolean },
  ): Promise<{ state: PublicState; hint: { text: string; examples: string[] } | null }> {
    const answers = answerMap(answerRows(db, session.id));
    const current = currentStepOf(session, answers);

    if (session.phase === 'consent') {
      if (answers.get(CONSENT_KEY) !== true) {
        throw new AppError('validation_failed', 'Please check the highlighted fields.', 422, {
          fields: { [CONSENT_KEY]: 'Please accept to start the interview.' },
        });
      }
      db.prepare(
        "update discovery_session set phase = 'map', current_step = 0, consent_at = ? where id = ?",
      ).run(nowIso(now()), session.id);
      session.phase = 'map';
      session.current_step = 0;
      return { state: buildPublicState(invite, session, answers, null), hint: null };
    }

    if (session.phase === 'map') {
      const next = session.current_step + 1;
      if (next < 12) {
        let hint: { text: string; examples: string[] } | null = null;
        const stepKey = `map:${next}`;
        reserveAiAttempt(invite, session, stepKey);
        try {
          const result = await interviewHint(call, {
            locale: invite.locale,
            customerName: invite.customer_name,
            phase: 'map',
            question: localized(
              MAP_STEPS[next + 1]?.fields[0]?.label ?? { de: '', en: '' },
              invite.locale,
            ),
            answers: interviewHistory(answers),
            followUpsUsed: 2,
            showIdeas: false,
            log,
          });
          finishAiAttempt(session, stepKey);
          if (result.hint || result.examples.length > 0) {
            hint = { text: result.hint ?? '', examples: result.examples };
          }
        } catch (error) {
          if (isProviderOutage(error)) releaseAiAttempt(session, stepKey);
          if (error instanceof AiUnavailable && error.reason === 'filtered') {
            // The hint is a comfort feature; a filtered hint must not stop the
            // interview. Move on without one.
            log.warn(
              { inviteId: invite.id, sessionId: session.id, step: next },
              'discovery hint was refused by the content filter; continuing without one',
            );
            hint = null;
          } else {
            throw aiError(error);
          }
        }
        db.prepare(
          'update discovery_session set current_step = ?, last_seen_at = ? where id = ?',
        ).run(next, nowIso(now()), session.id);
        session.current_step = next;
        return { state: buildPublicState(invite, session, answers, null), hint };
      }

      const shortcut =
        (body.shortcut === true || invite.mode === 'short') && invite.mode !== 'full';
      if (shortcut) {
        saveAnswers(session.id, [{ key: 'meta.shortcut', value: true }], 'customer');
        answers.set('meta.shortcut', true);
        db.prepare(
          "update discovery_session set phase = 'confirm', current_step = 0, suggestions_json = null, last_seen_at = ? where id = ?",
        ).run(nowIso(now()), session.id);
        session.phase = 'confirm';
        session.current_step = 0;
        return { state: buildPublicState(invite, session, answers, null), hint: null };
      }

      let suggested: SuggestedCluster[];
      const stepKey = 'clusters';
      reserveAiAttempt(invite, session, stepKey);
      try {
        suggested = await suggestClusters(call, {
          locale: invite.locale,
          customerName: invite.customer_name,
          answers: interviewHistory(answers),
          log,
        });
        finishAiAttempt(session, stepKey);
      } catch (error) {
        if (isProviderOutage(error)) releaseAiAttempt(session, stepKey);
        if (error instanceof AiUnavailable && error.reason === 'filtered') {
          // The customer still has to pick topics, so the interview continues:
          // the catalogue is always selectable without a suggestion.
          log.warn(
            { inviteId: invite.id, sessionId: session.id },
            'discovery cluster suggestion was refused by the content filter; offering the catalogue',
          );
          suggested = [];
        } else {
          throw aiError(error);
        }
      }
      if (invite.mode !== 'full' && suggested.length > 3) suggested = suggested.slice(0, 3);
      db.prepare(
        "update discovery_session set phase = 'clusters', current_step = 0, suggestions_json = ?, last_seen_at = ? where id = ?",
      ).run(JSON.stringify(suggested), nowIso(now()), session.id);
      session.phase = 'clusters';
      session.current_step = 0;
      session.suggestions_json = JSON.stringify(suggested);
      return { state: buildPublicState(invite, session, answers, null), hint: null };
    }

    if (session.phase === 'clusters') {
      const selected = selectedClusterIds(answers);
      if (selected.length === 0) {
        throw new AppError('validation_failed', 'Please check the highlighted fields.', 422, {
          fields: { 'clusters.selected': 'Please choose at least one topic.' },
        });
      }
      assertClusterLimit(invite.mode, selected.length);
      db.prepare(
        "update discovery_session set phase = 'deepen', current_step = 0, pending_json = null, last_seen_at = ? where id = ?",
      ).run(nowIso(now()), session.id);
      session.phase = 'deepen';
      session.current_step = 0;
      session.pending_json = null;
      return { state: buildPublicState(invite, session, answers, null), hint: null };
    }

    if (session.phase === 'deepen') {
      const clusters = selectedClusterIds(answers);
      const steps = deepenSteps(clusters);
      const entry = steps[session.current_step];

      if (current.pending) {
        db.prepare(
          'update discovery_session set pending_json = null, current_step = ?, last_seen_at = ? where id = ?',
        ).run(session.current_step + 1, nowIso(now()), session.id);
        session.pending_json = null;
        session.current_step += 1;
        return { state: buildPublicState(invite, session, answers, null), hint: null };
      }

      if (!entry) {
        db.prepare(
          "update discovery_session set phase = 'confirm', current_step = 0, last_seen_at = ? where id = ?",
        ).run(nowIso(now()), session.id);
        session.phase = 'confirm';
        session.current_step = 0;
        return { state: buildPublicState(invite, session, answers, null), hint: null };
      }

      const cluster = entry.cluster;
      const within = session.current_step % 8;
      const isLastQuestion = within === 6;
      const isIdeas = within === 7;

      if (isIdeas) {
        db.prepare(
          'update discovery_session set current_step = ?, last_seen_at = ? where id = ?',
        ).run(session.current_step + 1, nowIso(now()), session.id);
        session.current_step += 1;
        if (session.current_step >= steps.length) {
          db.prepare(
            "update discovery_session set phase = 'confirm', current_step = 0, last_seen_at = ? where id = ?",
          ).run(nowIso(now()), session.id);
          session.phase = 'confirm';
          session.current_step = 0;
        }
        return { state: buildPublicState(invite, session, answers, null), hint: null };
      }

      const usedFollowUps = [...answers.keys()].filter((key) =>
        key.startsWith(`deep.${cluster}.fu`),
      ).length;
      const nextEntry = steps[session.current_step + 1];
      const nextQuestion = nextEntry?.step.fields[0]?.label ?? { de: '', en: '' };
      let hint: { text: string; examples: string[] } | null = null;
      const stepKey = `deepen:${cluster}:${within}`;
      reserveAiAttempt(invite, session, stepKey);
      try {
        const result = await interviewHint(call, {
          locale: invite.locale,
          customerName: invite.customer_name,
          phase: 'deepen',
          question: localized(nextQuestion, invite.locale),
          answers: interviewHistory(answers),
          followUpsUsed: usedFollowUps,
          showIdeas: isLastQuestion,
          log,
        });
        finishAiAttempt(session, stepKey);
        if (isLastQuestion && result.ideas.length > 0) {
          const catalogue = result.ideas.map((title, index) => ({
            id: `i${index + 1}`,
            title,
            why: null,
          }));
          saveAnswers(
            session.id,
            [{ key: `deep.${cluster}.ideas.catalog`, value: catalogue }],
            'ai_suggested',
          );
          answers.set(`deep.${cluster}.ideas.catalog`, catalogue);
        }
        if (result.hint || result.examples.length > 0) {
          hint = { text: result.hint ?? '', examples: result.examples };
        }
        if (result.followUp) {
          const pending: PendingQuestion = {
            key: `deep.${cluster}.fu${usedFollowUps + 1}`,
            prompt: result.followUp,
            cluster,
            ordinal: usedFollowUps + 1,
          };
          db.prepare(
            'update discovery_session set pending_json = ?, last_seen_at = ? where id = ?',
          ).run(JSON.stringify(pending), nowIso(now()), session.id);
          session.pending_json = JSON.stringify(pending);
          return { state: buildPublicState(invite, session, answers, null), hint };
        }
      } catch (error) {
        if (isProviderOutage(error)) releaseAiAttempt(session, stepKey);
        if (error instanceof AiUnavailable && error.reason === 'filtered') {
          // A filtered hint must not block the step: the customer can answer
          // without one, so the interview moves on.
          log.warn(
            { inviteId: invite.id, sessionId: session.id, step: session.current_step },
            'discovery hint was refused by the content filter; continuing without one',
          );
          hint = null;
        } else {
          throw aiError(error);
        }
      }

      const target = resultNextIndex(steps, session.current_step, answers, cluster);
      db.prepare(
        'update discovery_session set current_step = ?, last_seen_at = ? where id = ?',
      ).run(target, nowIso(now()), session.id);
      session.current_step = target;
      if (target >= steps.length) {
        db.prepare(
          "update discovery_session set phase = 'confirm', current_step = 0, last_seen_at = ? where id = ?",
        ).run(nowIso(now()), session.id);
        session.phase = 'confirm';
        session.current_step = 0;
      }
      return { state: buildPublicState(invite, session, answers, null), hint };
    }

    if (session.phase === 'confirm') {
      if (session.current_step + 1 >= CONFIRM_STEPS.length) {
        db.prepare(
          'update discovery_session set current_step = ?, last_seen_at = ? where id = ?',
        ).run(CONFIRM_STEPS.length, nowIso(now()), session.id);
        session.current_step = CONFIRM_STEPS.length;
      } else {
        db.prepare(
          'update discovery_session set current_step = ?, last_seen_at = ? where id = ?',
        ).run(session.current_step + 1, nowIso(now()), session.id);
        session.current_step += 1;
      }
      return { state: buildPublicState(invite, session, answers, null), hint: null };
    }

    return { state: buildPublicState(invite, session, answers, null), hint: null };
  }

  /** Skip the idea card when the model returned no ideas. */
  function resultNextIndex(
    steps: Array<{ step: StepDef; cluster: string; isIdeas: boolean }>,
    current: number,
    answers: Map<string, unknown>,
    cluster: string,
  ): number {
    const next = current + 1;
    const entry = steps[next];
    if (entry?.isIdeas && ideasOf(answers, cluster).length === 0) return next + 1;
    return next;
  }

  function statusLabel(status: InviteStatus): string {
    return status;
  }

  // --- Operator routes -----------------------------------------------------

  app.get('/discovery/overview', { preHandler: app.requireRole('operator') }, async () => {
    purgeOld(now());
    expireStale(db, now());
    const counts = db
      .prepare('select status, count(*) as total from discovery_invite group by status')
      .all() as Array<{ status: InviteStatus; total: number }>;
    const byStatus: Record<string, number> = {
      open: 0,
      in_progress: 0,
      completed: 0,
      revoked: 0,
      expired: 0,
    };
    for (const row of counts) byStatus[statusLabel(row.status)] = row.total;
    const recent = db
      .prepare(
        `select i.*, s.phase, s.progress, s.last_seen_at,
                  (select count(*) from discovery_report r where r.session_id = s.id) as report_count
           from discovery_invite i left join discovery_session s on s.invite_id = i.id
           order by i.created_at desc, i.id desc limit 10`,
      )
      .all() as Array<
      InviteRow & {
        phase: string | null;
        progress: number | null;
        last_seen_at: string | null;
        report_count: number;
      }
    >;
    return {
      counts: byStatus,
      recent: recent.map((row) => ({
        id: row.id,
        customerName: row.customer_name,
        status: row.status,
        locale: row.locale,
        mode: row.mode,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        phase: row.phase,
        progress: row.progress ?? 0,
        lastSeenAt: row.last_seen_at,
        reportAvailable: row.report_count > 0,
      })),
    };
  });

  app.get(
    '/discovery/invites',
    {
      preHandler: app.requireRole('operator'),
      schema: { querystring: listQuery },
    },
    async (request) => {
      const query = request.query as {
        status?: InviteStatus;
        q?: string;
        limit: number;
        cursor?: string;
      };
      expireStale(db, now());
      const limit = query.limit ?? 25;
      const filterClauses: string[] = [];
      const filterParams: unknown[] = [];
      if (query.status) {
        filterClauses.push('status = ?');
        filterParams.push(query.status);
      }
      if (query.q && query.q.trim().length > 0) {
        filterClauses.push(
          "(lower(customer_name) like ? or lower(coalesce(contact_email, '')) like ?)",
        );
        const pattern = `%${query.q.trim().toLowerCase()}%`;
        filterParams.push(pattern, pattern);
      }
      const cursor = query.cursor ? decodeCursor(query.cursor) : null;
      if (query.cursor && !cursor) {
        throw new AppError('validation_failed', 'Invalid cursor.', 422, {
          fields: { cursor: 'Invalid cursor.' },
        });
      }
      const pageClauses = [...filterClauses];
      const pageParams = [...filterParams];
      if (cursor) {
        pageClauses.push('(created_at < ? or (created_at = ? and id < ?))');
        pageParams.push(cursor.created_at, cursor.created_at, cursor.id);
      }
      const filterWhere = filterClauses.length > 0 ? `where ${filterClauses.join(' and ')}` : '';
      const pageWhere = pageClauses.length > 0 ? `where ${pageClauses.join(' and ')}` : '';
      const rows = db
        .prepare(
          `select * from discovery_invite ${pageWhere} order by created_at desc, id desc limit ?`,
        )
        .all(...pageParams, limit + 1) as InviteRow[];

      // The total describes the filter, not the current page: a cursor must not
      // make "26-50 of 60" shrink to "of 25".
      const totalRow = db
        .prepare(`select count(*) as total from discovery_invite ${filterWhere}`)
        .get(...filterParams) as { total: number };

      const page = rows.slice(0, limit);
      const items = page.map((invite) => {
        const session = findSession(db, invite.id);
        return toInviteDto(invite, session, Boolean(session && findReport(db, session.id)));
      });
      const last = page.at(-1);
      return {
        items,
        total: totalRow.total,
        nextCursor:
          rows.length > limit && last
            ? encodeCursor({ created_at: last.created_at, id: last.id })
            : null,
      };
    },
  );

  app.post(
    '/discovery/invites',
    {
      preHandler: app.requireRole('operator'),
      schema: { body: inviteBody },
    },
    async (request, reply) => {
      const body = request.body as {
        customerName: string;
        contactEmail?: string;
        locale?: Locale;
        mode?: Mode;
        expiresInDays?: number;
        tenantId?: string;
      };
      const errors: Record<string, string> = {};
      const customerName = body.customerName.trim();
      if (customerName.length < 2) errors.customerName = 'Please enter a name.';
      const contactEmail = body.contactEmail?.trim() ?? null;
      if (contactEmail && !isEmail(contactEmail)) {
        errors.contactEmail = 'Please enter a valid email address.';
      }
      if (body.tenantId && !ctx.tenants().some((tenant) => tenant.id === body.tenantId)) {
        errors.tenantId = 'Unknown tenant.';
      }
      if (Object.keys(errors).length > 0) {
        throw new AppError('validation_failed', 'Please check the highlighted fields.', 422, {
          fields: errors,
        });
      }

      const token = newToken();
      const stamp = nowIso(now());
      const expiresAt = addDays(now(), body.expiresInDays ?? DEFAULT_EXPIRY_DAYS);
      const invite: InviteRow = {
        id: newId('dvi'),
        tenant_id: body.tenantId ?? null,
        customer_name: customerName,
        contact_email: contactEmail,
        locale: body.locale === 'en' ? 'en' : 'de',
        mode: body.mode ?? 'standard',
        token_hash: hashToken(token),
        status: 'open',
        expires_at: expiresAt,
        created_by: request.user?.id ?? 'system',
        created_at: stamp,
        completed_at: null,
        revoked_at: null,
      };
      db.prepare(
        `insert into discovery_invite
         (id, tenant_id, customer_name, contact_email, locale, mode, token_hash, status, expires_at, created_by, created_at, completed_at, revoked_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null)`,
      ).run(
        invite.id,
        invite.tenant_id,
        invite.customer_name,
        invite.contact_email,
        invite.locale,
        invite.mode,
        invite.token_hash,
        invite.status,
        invite.expires_at,
        invite.created_by,
        invite.created_at,
      );

      const link = `${config.publicUrl.replace(/\/$/, '')}/d/${token}`;
      log.info({ inviteId: invite.id, mode: invite.mode }, 'discovery invite created');
      reply.code(201);
      return {
        invite: toInviteDto(invite, null, false),
        link,
        mailSent: false,
        mailNote: 'This build has no mail transport. Share the link with the customer yourself.',
      };
    },
  );

  app.get(
    '/discovery/invites/:id',
    {
      preHandler: app.requireRole('operator'),
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1, maxLength: 80 } },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const invite = requireInvite(db, id);
      const session = findSession(db, invite.id);
      const reportRow = session ? findReport(db, session.id) : null;
      const answers = session
        ? answerRows(db, session.id).map((row) => ({
            key: row.question_key,
            label: answerLabel(row.question_key),
            value: parseJson<unknown>(row.value_json),
            source: row.source,
            updatedAt: row.updated_at,
          }))
        : [];
      return {
        invite: toInviteDto(invite, session, Boolean(reportRow)),
        answers,
        report: reportRow ? reportOf(reportRow) : null,
        reportModel: reportRow?.model ?? null,
      };
    },
  );

  app.post(
    '/discovery/invites/:id/revoke',
    {
      preHandler: app.requireRole('operator'),
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1, maxLength: 80 } },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const invite = requireInvite(db, id);
      if (invite.status === 'completed') {
        throw new AppError(
          'discovery_invite_completed',
          'A completed invite cannot be revoked.',
          409,
        );
      }
      if (invite.status !== 'revoked') {
        const stamp = nowIso(now());
        db.prepare(
          "update discovery_invite set status = 'revoked', revoked_at = ? where id = ?",
        ).run(stamp, invite.id);
        invite.status = 'revoked';
        invite.revoked_at = stamp;
        log.info({ inviteId: invite.id }, 'discovery invite revoked');
      }
      const session = findSession(db, invite.id);
      return {
        invite: toInviteDto(invite, session, Boolean(session && findReport(db, session.id))),
      };
    },
  );

  app.post(
    '/discovery/invites/:id/resend',
    {
      preHandler: app.requireRole('operator'),
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1, maxLength: 80 } },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const invite = requireInvite(db, id);
      if (invite.status === 'completed' || invite.status === 'revoked') {
        throw new AppError(
          'discovery_invite_closed',
          'A completed or revoked invite cannot get a new link.',
          409,
        );
      }
      const token = newToken();
      const stamp = nowIso(now());
      const expiresAt = addDays(now(), DEFAULT_EXPIRY_DAYS);
      db.prepare(
        "update discovery_invite set token_hash = ?, status = 'open', expires_at = ? where id = ?",
      ).run(hashToken(token), expiresAt, invite.id);
      invite.token_hash = hashToken(token);
      invite.status = 'open';
      invite.expires_at = expiresAt;
      const session = findSession(db, invite.id);
      if (session) {
        // The customer gets a fresh link, so the attempt budget starts over:
        // the old link's failures must not block the new one.
        // A new link gets a fresh budget: the old link's failures, its step
        // counter and its used-up token budget must not carry over.
        db.prepare(
          `update discovery_session
              set complete_attempts = 0, ai_attempts = 0, ai_step_key = null, ai_step_attempts = 0
            where id = ?`,
        ).run(session.id);
        session.complete_attempts = 0;
        session.ai_attempts = 0;
      }
      log.info({ inviteId: invite.id, at: stamp }, 'discovery invite link rotated');
      return {
        invite: toInviteDto(invite, session, Boolean(session && findReport(db, session.id))),
        link: `${config.publicUrl.replace(/\/$/, '')}/d/${token}`,
        mailSent: false,
        mailNote:
          'This build has no mail transport. Share the new link with the customer yourself.',
      };
    },
  );

  app.get(
    '/discovery/invites/:id/report',
    {
      preHandler: app.requireRole('operator'),
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1, maxLength: 80 } },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const invite = requireInvite(db, id);
      const session = findSession(db, invite.id);
      if (!session) throw new AppError('discovery_report_not_found', 'No report yet.', 404);
      const reportRow = findReport(db, session.id);
      if (!reportRow) throw new AppError('discovery_report_not_found', 'No report yet.', 404);
      const report = reportOf(reportRow);
      if (!report)
        throw new AppError('discovery_report_invalid', 'The stored report is unreadable.', 500);
      return {
        invite: toInviteDto(invite, session, true),
        report,
        model: reportRow.model,
        createdAt: reportRow.created_at,
      };
    },
  );

  // --- Public routes -------------------------------------------------------

  const guard = publicRateLimit();

  app.get(
    '/discovery/public/:token',
    {
      preHandler: guard,
      logLevel: 'silent',
      schema: { params: tokenParams },
    },
    async (request, reply) => {
      const { token } = request.params as { token: string };
      const invite = findInviteByToken(db, token);
      if (!invite) throw new AppError('discovery_invite_not_found', 'This link is not valid.', 404);
      markExpiredIfNeeded(db, invite, now(), false);
      if (invite.status === 'revoked') {
        throw new AppError('discovery_link_revoked', 'This link was revoked.', 410);
      }
      if (invite.status === 'expired') {
        throw new AppError('discovery_link_expired', 'This link has expired.', 410);
      }
      const session = findSession(db, invite.id);
      if (invite.status === 'completed') {
        // Read-only after completion: a reload shows the result with 410, and
        // no write happens on this GET.
        reply.code(410);
        return completedPayload(invite, session);
      }
      const rows = session ? answerRows(db, session.id) : [];
      return buildPublicState(invite, session, answerMap(rows), null);
    },
  );

  app.post(
    '/discovery/public/:token/answers',
    {
      preHandler: guard,
      logLevel: 'silent',
      schema: { params: tokenParams, body: answersBody },
    },
    async (request) => {
      const { token } = request.params as { token: string };
      const body = request.body as { answers: Array<{ key: string; value: unknown }> };
      const { invite } = openInviteByToken(token);
      requireEditable(invite);
      const session = ensureSession(invite);
      const answers = answerMap(answerRows(db, session.id));
      const fields = expectedFields(session, answers);
      const allowed = new Set(fields.map((field) => field.key));
      const input: Record<string, unknown> = {};
      for (const entry of body.answers) {
        if (!allowed.has(entry.key)) {
          throw new AppError('validation_failed', 'Please check the highlighted fields.', 422, {
            fields: { [entry.key]: 'This answer does not belong to the current question.' },
          });
        }
        input[entry.key] = entry.value;
      }
      const cleaned = validateFields(fields, input);
      saveAnswers(
        session.id,
        Object.entries(cleaned).map(([key, value]) => ({ key, value })),
        'customer',
      );
      for (const [key, value] of Object.entries(cleaned)) answers.set(key, value);
      db.prepare('update discovery_session set last_seen_at = ? where id = ?').run(
        nowIso(now()),
        session.id,
      );
      return buildPublicState(invite, session, answers, null);
    },
  );

  app.post(
    '/discovery/public/:token/advance',
    {
      preHandler: guard,
      logLevel: 'silent',
      schema: { params: tokenParams, body: advanceBody },
    },
    async (request) => {
      const { token } = request.params as { token: string };
      const body = request.body as { shortcut?: boolean };
      const { invite } = openInviteByToken(token);
      requireEditable(invite);
      const session = ensureSession(invite);
      return advance(invite, session, body);
    },
  );

  app.post(
    '/discovery/public/:token/contact',
    {
      preHandler: guard,
      logLevel: 'silent',
      schema: { params: tokenParams, body: contactBody },
    },
    async (request) => {
      const { token } = request.params as { token: string };
      const body = request.body as { wanted: boolean; way?: string };
      const { invite } = openInviteByToken(token);
      requireEditable(invite);
      const session = ensureSession(invite);
      const answers = answerMap(answerRows(db, session.id));
      if (session.phase !== 'confirm' && session.phase !== 'deepen' && session.phase !== 'map') {
        throw new AppError('discovery_not_ready', 'The interview has not reached this step.', 409);
      }
      const way = body.way?.trim() ?? '';
      if (body.wanted && way.length === 0) {
        throw new AppError('validation_failed', 'Please check the highlighted fields.', 422, {
          fields: { 'confirm.contact.way': 'Please say how we can reach you.' },
        });
      }
      saveAnswers(
        session.id,
        [
          { key: 'confirm.contact.wanted', value: body.wanted },
          { key: 'confirm.contact.way', value: way },
        ],
        'customer',
      );
      answers.set('confirm.contact.wanted', body.wanted);
      answers.set('confirm.contact.way', way);
      db.prepare('update discovery_session set last_seen_at = ? where id = ?').run(
        nowIso(now()),
        session.id,
      );
      return buildPublicState(invite, session, answers, null);
    },
  );

  app.post(
    '/discovery/public/:token/complete',
    {
      preHandler: guard,
      logLevel: 'silent',
      schema: { params: tokenParams },
    },
    async (request) => {
      const { token } = request.params as { token: string };
      const invite = findInviteByToken(db, token);
      if (!invite) throw new AppError('discovery_invite_not_found', 'This link is not valid.', 404);
      markExpiredIfNeeded(db, invite, now(), true);
      if (invite.status === 'revoked') {
        throw new AppError('discovery_link_revoked', 'This link was revoked.', 410);
      }
      if (invite.status === 'expired') {
        throw new AppError('discovery_link_expired', 'This link has expired.', 410);
      }
      const session = findSession(db, invite.id);
      if (invite.status === 'completed' && session) {
        return completedPayload(invite, session);
      }
      requireEditable(invite);
      if (!session) {
        throw new AppError('discovery_not_ready', 'The interview has not started.', 409);
      }
      const existing = findReport(db, session.id);
      if (existing) {
        if (invite.status !== 'completed') {
          const stamp = nowIso(now());
          db.prepare(
            "update discovery_invite set status = 'completed', completed_at = ? where id = ?",
          ).run(stamp, invite.id);
          invite.status = 'completed';
          invite.completed_at = stamp;
        }
        return completedPayload(invite, session);
      }
      if (session.phase !== 'confirm' || session.current_step < CONFIRM_STEPS.length) {
        throw new AppError(
          'discovery_not_ready',
          'The confirmation questions are not answered yet.',
          409,
        );
      }

      // Two counters, both counted before the model runs, because a failed
      // attempt also costs tokens and the condition in each update makes the
      // limit race-free: the assessment budget and the link's total AI budget.
      if (session.complete_attempts >= COMPLETE_ATTEMPT_LIMIT) {
        log.warn(
          { inviteId: invite.id, sessionId: session.id, limit: COMPLETE_ATTEMPT_LIMIT },
          'discovery assessment refused: attempt limit reached',
        );
        throw new AppError(
          'discovery_complete_limit_reached',
          'The assessment was requested too often for this link.',
          429,
        );
      }
      // The assessment is not a step: repeating it after a counted failure is
      // legitimate, and `COMPLETE_ATTEMPT_LIMIT` already caps it.
      reserveAiAttempt(invite, session, 'assessment', false);
      const attempt = db
        .prepare(
          'update discovery_session set complete_attempts = complete_attempts + 1 where id = ? and complete_attempts < ?',
        )
        .run(session.id, COMPLETE_ATTEMPT_LIMIT);
      if (attempt.changes === 0) {
        releaseAiAttempt(session, 'assessment');
        log.warn(
          { inviteId: invite.id, sessionId: session.id, limit: COMPLETE_ATTEMPT_LIMIT },
          'discovery assessment refused: attempt limit reached',
        );
        throw new AppError(
          'discovery_complete_limit_reached',
          'The assessment was requested too often for this link.',
          429,
        );
      }
      session.complete_attempts += 1;

      const answers = answerMap(answerRows(db, session.id));
      const selected = selectedClusterIds(answers);
      let result: { report: AnalysisReport; model: string };
      try {
        result = await analyse(call, {
          locale: invite.locale,
          customerName: invite.customer_name,
          selectedClusters: selected,
          answers: interviewHistory(answers),
          log,
        });
      } catch (error) {
        // A provider outage or a missing model assignment is not the
        // customer's fault and produced nothing usable, so it costs no budget
        // at all; otherwise five provider hiccups would lock the link out.
        if (isProviderOutage(error)) {
          db.prepare(
            'update discovery_session set complete_attempts = complete_attempts - 1 where id = ? and complete_attempts > 0',
          ).run(session.id);
          session.complete_attempts = Math.max(0, session.complete_attempts - 1);
          releaseAiAttempt(session, 'assessment');
        }
        throw aiError(error);
      }

      const stamp = nowIso(now());
      const complete = db.transaction(() => {
        db.prepare(
          'insert into discovery_report (id, session_id, model, summary_json, created_at) values (?, ?, ?, ?, ?) on conflict(session_id) do nothing',
        ).run(newId('rpt'), session.id, result.model, JSON.stringify(result.report), stamp);
        db.prepare(
          'update discovery_session set completed_at = ?, progress = 100, last_seen_at = ? where id = ?',
        ).run(stamp, stamp, session.id);
        db.prepare(
          "update discovery_invite set status = 'completed', completed_at = ? where id = ?",
        ).run(stamp, invite.id);
      });
      complete();
      invite.status = 'completed';
      invite.completed_at = stamp;
      session.completed_at = stamp;
      session.progress = 100;
      log.info({ inviteId: invite.id, model: result.model }, 'discovery report created');
      return completedPayload(invite, session);
    },
  );

  log.debug(`${manifest.id} plugin registered`);
}

export default { manifest, register };
