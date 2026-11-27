/**
 * The only path to a model: the llm-providers plugin.
 *
 * This module never opens a socket and never knows a key. It calls the sibling
 * route through `ctx.callInternal`, parses the JSON the model returned and
 * validates it. A malformed answer is an outage, not something to paper over
 * with invented content.
 */

import type { InternalRequest, InternalResponse } from '../../kernel/context.ts';
import type { Locale } from './catalog.ts';
import { CLUSTERS_BY_ID } from './catalog.ts';
import type { SuggestedCluster } from './store.ts';

export const INTERVIEW_PURPOSE = 'discovery.interview';
export const ANALYSIS_PURPOSE = 'discovery.analysis';

export type CallInternal = (caller: string, request: InternalRequest) => Promise<InternalResponse>;

export type AiFailureReason =
  | 'not_configured'
  | 'unavailable'
  | 'timeout'
  | 'invalid_output'
  | 'truncated'
  | 'caller_not_allowed';

/** A logger shape the plugin context satisfies. */
export interface AiLogger {
  warn(obj: Record<string, unknown>, message: string): void;
}

/**
 * Token budgets per call. Reasoning models spend `max_tokens` on their own
 * reasoning, so a budget that only fits the JSON gets cut off mid-object and
 * used to surface as a schema error.
 */
export const HINT_MAX_TOKENS = 900;
export const CLUSTER_MAX_TOKENS = 900;
export const ANALYSIS_MAX_TOKENS = 4000;
/** The provider route accepts at most 8192; the retry stays under it. */
const MAX_TOKENS_CAP = 8192;
/**
 * Wall-clock budget per provider attempt.
 *
 * The provider repeats a timing-out call once on its own, so one attempt can
 * take twice this long. Both numbers stay below the browser's 45 s budget for
 * the public discovery routes, also with the internal repeat.
 */
export const HINT_TIMEOUT_MS = 20_000;
export const ANALYSIS_TIMEOUT_MS = 20_000;
/**
 * Deadline for one `complete()` call including the truncation retry. The
 * browser gives up at 45 s, so the server must answer before that: the retry
 * only starts while enough of this budget is left.
 */
export const AI_CALL_BUDGET_MS = 42_000;
/** Below this a retry cannot finish usefully, so it is skipped. */
const MIN_RETRY_MS = 5_000;

export class AiUnavailable extends Error {
  readonly reason: AiFailureReason;

  constructor(reason: AiFailureReason, message: string) {
    super(message);
    this.name = 'AiUnavailable';
    this.reason = reason;
  }
}

export interface InterviewHint {
  hint: string | null;
  followUp: string | null;
  ideas: string[];
  examples: string[];
}

export interface AnalysisCluster {
  id: string;
  title: string;
  summary: string;
}

export interface AnalysisOpportunity {
  title: string;
  benefit: string;
  effort: string;
  risk: string;
  dataMaturity: string;
  rationale: string;
}

export interface AnalysisReport {
  summary: string;
  clusters: AnalysisCluster[];
  opportunities: AnalysisOpportunity[];
  quickWins: string[];
  openQuestions: string[];
  nextStep: string;
}

const MAX_SUMMARY = 4000;
const MAX_FIELD = 600;
const MAX_LONG_FIELD = 2000;

function trimText(value: unknown, max: number, required: boolean): string | null {
  if (typeof value !== 'string') return required ? '' : null;
  const text = value.trim();
  if (text.length === 0) return required ? '' : null;
  return text.slice(0, max);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Models wrap JSON in fences or prose; take the outermost object. */
export function extractJson(content: string): unknown {
  const text = content
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '');
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

interface CompleteRequest {
  call: CallInternal;
  purpose: string;
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
}

interface CompleteAnswer {
  content: string;
  finishReason: string;
  model: string;
}

/** One provider round trip; returns the raw content, finish reason and model. */
async function completeOnce(request: CompleteRequest): Promise<CompleteAnswer> {
  let response: InternalResponse;
  try {
    response = await request.call('automation-discovery', {
      method: 'POST',
      url: '/api/v1/llm/internal/complete',
      payload: {
        purpose: request.purpose,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user.slice(0, 24_000) },
        ],
        temperature: 0.2,
        maxTokens: request.maxTokens,
        responseFormat: { type: 'json_object' },
        timeoutMs: request.timeoutMs,
        metadata: { requestId: `discovery-${Date.now()}` },
      },
    });
  } catch {
    throw new AiUnavailable('unavailable', 'The AI service could not be reached.');
  }

  if (response.status === 404) {
    throw new AiUnavailable('not_configured', 'The AI plugin is not installed.');
  }
  if (response.status === 409) {
    throw new AiUnavailable('not_configured', 'No model is assigned to this purpose.');
  }
  if (response.status === 403) {
    throw new AiUnavailable('caller_not_allowed', 'The AI plugin does not allow this caller.');
  }
  if (response.status === 429) {
    throw new AiUnavailable('unavailable', 'The AI service is rate limited.');
  }
  if (response.status === 504) {
    throw new AiUnavailable('timeout', 'The AI service did not answer in time.');
  }
  if (response.status !== 200) {
    throw new AiUnavailable('unavailable', `The AI service answered ${response.status}.`);
  }

  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    throw new AiUnavailable('invalid_output', 'The AI response was not JSON.');
  }
  const record = asRecord(body);
  const message = asRecord(record?.message);
  const content = typeof message?.content === 'string' ? message.content : '';
  if (content.trim().length === 0) {
    throw new AiUnavailable('invalid_output', 'The AI response was empty.');
  }
  const finishReason = typeof record?.finishReason === 'string' ? record.finishReason : 'stop';
  const modelRecord = asRecord(record?.model);
  const model = typeof modelRecord?.modelKey === 'string' ? modelRecord.modelKey : 'unknown';
  return { content, finishReason, model };
}

/**
 * Calls the model and parses its JSON.
 *
 * `finishReason: 'length'` means the answer was cut off at the token budget;
 * the content then usually misses its closing braces. That is not a schema
 * problem the customer caused, so it gets one retry with a doubled budget and,
 * if it is cut off again, its own reason and log line instead of the generic
 * "did not match the schema" message.
 */
async function complete(
  request: CompleteRequest,
  log?: AiLogger,
): Promise<{ parsed: unknown; model: string }> {
  const deadline = Date.now() + AI_CALL_BUDGET_MS;
  const first = await completeOnce(request);
  let answer = first;

  if (first.finishReason === 'length') {
    const retryMaxTokens = Math.min(request.maxTokens * 2, MAX_TOKENS_CAP);
    const remaining = deadline - Date.now();
    log?.warn(
      {
        purpose: request.purpose,
        maxTokens: request.maxTokens,
        retryMaxTokens,
        outputChars: first.content.length,
        finishReason: first.finishReason,
        remainingMs: remaining,
      },
      'discovery ai answer hit the token budget; retrying with a larger one',
    );
    if (remaining < MIN_RETRY_MS) {
      // The answer is cut off, but a retry would outlive the client's budget.
      log?.warn(
        { purpose: request.purpose, remainingMs: remaining },
        'discovery ai retry skipped: no time left in the call budget',
      );
      throw new AiUnavailable(
        'truncated',
        'The AI answer was cut off by the token budget. Please try again.',
      );
    }
    answer = await completeOnce({
      ...request,
      maxTokens: retryMaxTokens,
      timeoutMs: Math.min(request.timeoutMs, remaining),
    });
    if (answer.finishReason === 'length') {
      log?.warn(
        {
          purpose: request.purpose,
          maxTokens: retryMaxTokens,
          outputChars: answer.content.length,
          finishReason: answer.finishReason,
        },
        'discovery ai answer was cut off twice; giving up',
      );
      throw new AiUnavailable(
        'truncated',
        'The AI answer was cut off by the token budget. Please try again.',
      );
    }
  }

  const parsed = extractJson(answer.content);
  if (parsed === null) {
    throw new AiUnavailable('invalid_output', 'The AI response was not a JSON object.');
  }
  return { parsed, model: answer.model };
}

const INTERVIEW_RULES = `You support a structured automation interview. Answer in the requested language.
Return one JSON object only, with these optional keys:
- "hint": one short sentence that helps the customer answer (max 240 characters).
- "followUp": at most one concrete follow-up question about the previous answer (max 240 characters). Only if it adds real information.
- "ideas": 2 to 3 short automation ideas for the current topic, each max 160 characters.
- "examples": 1 or 2 concrete example answers, only when the customer is unsure.
Never invent numbers, benchmarks, customers or sources. No markdown.`;

export async function interviewHint(
  call: CallInternal,
  input: {
    locale: Locale;
    customerName: string;
    phase: string;
    question: string;
    answers: Array<{ question: string; answer: string }>;
    followUpsUsed: number;
    showIdeas: boolean;
    log?: AiLogger;
  },
): Promise<InterviewHint> {
  const language = input.locale === 'en' ? 'English' : 'German';
  const history = input.answers
    .slice(-14)
    .map((entry) => `- ${entry.question}: ${entry.answer.slice(0, 500)}`)
    .join('\n');
  const user = [
    `Language: ${language}.`,
    `Customer: ${input.customerName}.`,
    `Phase: ${input.phase}.`,
    `Current question: ${input.question}`,
    `Follow-ups already used in this cluster: ${input.followUpsUsed} of 2.`,
    input.showIdeas ? 'Return 2 or 3 ideas for this cluster.' : 'Return a hint, not ideas.',
    'Answers so far:',
    history || '(none)',
  ].join('\n');

  const { parsed: raw } = await complete(
    {
      call,
      purpose: INTERVIEW_PURPOSE,
      system: INTERVIEW_RULES,
      user,
      maxTokens: HINT_MAX_TOKENS,
      timeoutMs: HINT_TIMEOUT_MS,
    },
    input.log,
  );
  const parsed = asRecord(raw);
  if (!parsed) throw new AiUnavailable('invalid_output', 'The AI response was not an object.');

  const ideas = Array.isArray(parsed.ideas)
    ? parsed.ideas
        .map((idea) => trimText(idea, 200, true))
        .filter((idea): idea is string => Boolean(idea))
        .slice(0, 3)
    : [];
  const examples = Array.isArray(parsed.examples)
    ? parsed.examples
        .map((example) => trimText(example, 200, true))
        .filter((example): example is string => Boolean(example))
        .slice(0, 2)
    : [];

  return {
    hint: trimText(parsed.hint, 300, false),
    followUp: input.followUpsUsed < 2 ? trimText(parsed.followUp, 300, false) : null,
    ideas,
    examples,
  };
}

export async function suggestClusters(
  call: CallInternal,
  input: {
    locale: Locale;
    customerName: string;
    answers: Array<{ question: string; answer: string }>;
    log?: AiLogger;
  },
): Promise<SuggestedCluster[]> {
  const language = input.locale === 'en' ? 'English' : 'German';
  const catalogue = [...CLUSTERS_BY_ID.values()]
    .map((cluster) => `${cluster.id}: ${cluster.label.en} — ${cluster.description.en}`)
    .join('\n');
  const history = input.answers
    .map((entry) => `- ${entry.question}: ${entry.answer.slice(0, 600)}`)
    .join('\n');
  const system = `You pick automation topics from a fixed catalogue. Return one JSON object:
{"clusters":[{"id":"A","reason":"one short sentence"}]}
Choose 2 to 5 ids from the catalogue, most relevant first. Use only catalogue ids. Never invent a new id. Answer the reason in ${language}.`;
  const user = `Catalogue:\n${catalogue}\n\nCustomer: ${input.customerName}\n\nAnswers:\n${history}`;

  const { parsed: raw } = await complete(
    {
      call,
      purpose: INTERVIEW_PURPOSE,
      system,
      user,
      maxTokens: CLUSTER_MAX_TOKENS,
      timeoutMs: HINT_TIMEOUT_MS,
    },
    input.log,
  );
  const parsed = asRecord(raw);
  const list = Array.isArray(parsed?.clusters) ? parsed.clusters : [];
  const picked: SuggestedCluster[] = [];
  for (const item of list) {
    const record = asRecord(item);
    const id = typeof record?.id === 'string' ? record.id.trim().toUpperCase() : '';
    if (!CLUSTERS_BY_ID.has(id) || picked.some((entry) => entry.id === id)) continue;
    const reason = trimText(record?.reason, 300, false);
    picked.push(reason ? { id, reason } : { id });
    if (picked.length === 5) break;
  }
  if (picked.length < 2) {
    throw new AiUnavailable('invalid_output', 'The AI did not return two valid clusters.');
  }
  return picked;
}

const ANALYSIS_RULES = `You write a structured automation assessment for a business customer.
Return one JSON object with exactly these keys:
{
  "summary": "3 to 6 sentences",
  "clusters": [{"id":"A","title":"...","summary":"why this topic matters here"}],
  "opportunities": [{"title":"...","benefit":"...","effort":"low|medium|high","risk":"low|medium|high","dataMaturity":"low|medium|high","rationale":"..."}],
  "quickWins": ["...", "..."],
  "openQuestions": ["...", "..."],
  "nextStep": "one concrete next step"
}
Rules: 1 to 5 clusters, using only the given cluster ids. 1 to 12 opportunities, most valuable first.
quickWins: 1 to 5 items. openQuestions: 1 to 10 items for the first call. No invented numbers, benchmarks or sources.
The result is a proposal, not a promise. Answer in the requested language.`;

function requireText(value: unknown, max: number, label: string): string {
  const text = trimText(value, max, true);
  if (!text) throw new AiUnavailable('invalid_output', `The report is missing ${label}.`);
  return text;
}

function parseReport(raw: unknown, selectedClusters: string[]): AnalysisReport {
  const record = asRecord(raw);
  if (!record) throw new AiUnavailable('invalid_output', 'The report was not an object.');

  const summary = requireText(record.summary, MAX_SUMMARY, 'summary');

  const clusterList = Array.isArray(record.clusters) ? record.clusters : [];
  const allowed = selectedClusters.length > 0 ? selectedClusters : null;
  const clusters: AnalysisCluster[] = [];
  for (const item of clusterList) {
    const entry = asRecord(item);
    const id = typeof entry?.id === 'string' ? entry.id.trim().toUpperCase() : '';
    if (allowed ? !allowed.includes(id) : !CLUSTERS_BY_ID.has(id)) continue;
    if (clusters.some((cluster) => cluster.id === id)) continue;
    clusters.push({
      id,
      title: requireText(entry?.title, 200, 'a cluster title'),
      summary: requireText(entry?.summary, MAX_LONG_FIELD, 'a cluster summary'),
    });
  }
  if (clusters.length === 0) {
    throw new AiUnavailable('invalid_output', 'The report has no valid cluster.');
  }

  const opportunityList = Array.isArray(record.opportunities) ? record.opportunities : [];
  const opportunities: AnalysisOpportunity[] = [];
  for (const item of opportunityList.slice(0, 12)) {
    const entry = asRecord(item);
    if (!entry) continue;
    opportunities.push({
      title: requireText(entry.title, 200, 'an opportunity title'),
      benefit: requireText(entry.benefit, MAX_FIELD, 'an opportunity benefit'),
      effort: requireText(entry.effort, 60, 'an opportunity effort'),
      risk: requireText(entry.risk, 60, 'an opportunity risk'),
      dataMaturity: requireText(entry.dataMaturity, 60, 'an opportunity data maturity'),
      rationale: requireText(entry.rationale, MAX_LONG_FIELD, 'an opportunity rationale'),
    });
  }
  if (opportunities.length === 0) {
    throw new AiUnavailable('invalid_output', 'The report has no opportunity.');
  }

  const asList = (value: unknown, max: number, maxLength: number): string[] =>
    Array.isArray(value)
      ? value
          .map((entry) => trimText(entry, maxLength, true))
          .filter((entry): entry is string => Boolean(entry))
          .slice(0, max)
      : [];

  return {
    summary,
    clusters,
    opportunities,
    quickWins: asList(record.quickWins, 5, MAX_FIELD),
    openQuestions: asList(record.openQuestions, 10, MAX_FIELD),
    nextStep: requireText(record.nextStep, MAX_FIELD, 'a next step'),
  };
}

export async function analyse(
  call: CallInternal,
  input: {
    locale: Locale;
    customerName: string;
    selectedClusters: string[];
    answers: Array<{ question: string; answer: string }>;
    log?: AiLogger;
  },
): Promise<{ report: AnalysisReport; model: string }> {
  const language = input.locale === 'en' ? 'English' : 'German';
  const history = input.answers
    .map((entry) => `- ${entry.question}: ${entry.answer.slice(0, 1200)}`)
    .join('\n');
  const user = [
    `Language: ${language}.`,
    `Customer: ${input.customerName}.`,
    `Selected cluster ids: ${input.selectedClusters.join(', ') || '(none)'}.`,
    'Interview answers:',
    history,
  ].join('\n');

  const { parsed, model } = await complete(
    {
      call,
      purpose: ANALYSIS_PURPOSE,
      system: ANALYSIS_RULES,
      user,
      maxTokens: ANALYSIS_MAX_TOKENS,
      timeoutMs: ANALYSIS_TIMEOUT_MS,
    },
    input.log,
  );
  return { report: parseReport(parsed, input.selectedClusters), model };
}
