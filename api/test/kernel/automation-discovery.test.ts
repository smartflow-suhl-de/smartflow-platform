import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { beforeEach } from 'node:test';
import { createTestApp, type TestApp } from './helpers.ts';
import {
  aiAttemptLimit,
  COMPLETE_ATTEMPT_LIMIT,
  PublicRateLimiter,
  publicRateLimiter,
  STEP_ATTEMPT_LIMIT,
} from '../../src/plugins/automation-discovery/server.ts';
import {
  analyse,
  AiUnavailable,
  interviewHint,
  suggestClusters,
  AI_CALL_BUDGET_MS,
  ANALYSIS_MAX_TOKENS,
  ANALYSIS_TIMEOUT_MS,
  withDeadline,
  isFiltered,
  isTruncated,
  HINT_MAX_TOKENS,
  HINT_TIMEOUT_MS,
} from '../../src/plugins/automation-discovery/ai.ts';

// The public limiter is module-global, so one test file's requests would eat
// into the next one's per-IP budget and turn a green suite red at random.
beforeEach(() => publicRateLimiter.clear());

interface LlmReply {
  status: number;
  body: string;
}

type LlmHandler = (payload: unknown) => LlmReply;

const GOOD_REPORT = {
  summary:
    'Das Unternehmen verliert Zeit bei Angeboten und Rechnungen. Zwei Themen sind klar priorisiert.',
  clusters: [
    { id: 'A', title: 'Vertrieb & Angebote', summary: 'Angebote werden manuell erstellt.' },
    { id: 'B', title: 'Auftrag & Rechnung', summary: 'Rechnungen werden doppelt erfasst.' },
  ],
  opportunities: [
    {
      title: 'Angebotsentwurf aus CRM-Daten',
      benefit: 'Weniger Tipparbeit und schnellere Reaktion.',
      effort: 'medium',
      risk: 'low',
      dataMaturity: 'medium',
      rationale: 'Die Daten liegen bereits strukturiert im CRM.',
    },
    {
      title: 'Rechnungsprüfung gegen Bestellung',
      benefit: 'Weniger Fehler bei der Freigabe.',
      effort: 'medium',
      risk: 'medium',
      dataMaturity: 'low',
      rationale: 'Bestellungen liegen teils als PDF vor.',
    },
  ],
  quickWins: ['E-Mail-Vorlagen für Standardangebote'],
  openQuestions: ['Welches CRM wird genutzt?', 'Wer gibt Rechnungen frei?'],
  nextStep: 'Erstgespräch mit Blick auf den Angebotsprozess.',
};

function llmReply(payload: unknown): LlmReply {
  const request = payload as { messages?: Array<{ content?: string }> } | undefined;
  const system = request?.messages?.[0]?.content ?? '';
  const user = request?.messages?.[1]?.content ?? '';

  if (system.includes('pick automation topics')) {
    return {
      status: 200,
      body: JSON.stringify({
        message: {
          content: JSON.stringify({
            clusters: [
              { id: 'A', reason: 'Angebote kosten Zeit.' },
              { id: 'B', reason: 'Rechnungen werden doppelt erfasst.' },
              { id: 'C', reason: 'E-Mail-Flut.' },
            ],
          }),
        },
        model: { modelKey: 'test-model' },
      }),
    };
  }
  if (system.includes('structured automation assessment')) {
    return {
      status: 200,
      body: JSON.stringify({
        message: { content: JSON.stringify(GOOD_REPORT) },
        model: { modelKey: 'test-model' },
      }),
    };
  }
  return {
    status: 200,
    body: JSON.stringify({
      message: {
        content: JSON.stringify({
          hint: 'Ein kurzer Satz genügt.',
          examples: ['Zum Beispiel: Angebot per E-Mail.'],
          ...(user.includes('Return 2 or 3 ideas')
            ? { ideas: ['Angebotsentwurf vorbereiten', 'Rechnung prüfen'] }
            : {}),
        }),
      },
      model: { modelKey: 'test-model' },
    }),
  };
}

/** Replaces the in-process sibling call with a fake llm-providers route. */
function stubLlm(ctx: TestApp, handler: LlmHandler): () => void {
  const original = ctx.app.inject.bind(ctx.app);
  const patched = async (options: never) => {
    const url = typeof options === 'string' ? options : (options as { url: string }).url;
    if (typeof url === 'string' && url.startsWith('/api/v1/llm/internal/')) {
      const payload =
        typeof options === 'string' ? undefined : (options as { payload?: unknown }).payload;
      const reply = handler(payload);
      return {
        statusCode: reply.status,
        body: reply.body,
        headers: {},
        payload: reply.body,
        rawPayload: Buffer.from(reply.body),
        json: () => JSON.parse(reply.body),
      } as never;
    }
    return original(options as never);
  };
  ctx.app.inject = patched as typeof ctx.app.inject;
  return () => {
    ctx.app.inject = original as typeof ctx.app.inject;
  };
}

async function createInvite(
  ctx: TestApp,
  cookie: string,
  body: Record<string, unknown> = { customerName: 'Muster GmbH' },
): Promise<{ id: string; link: string; token: string }> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/discovery/invites',
    headers: { cookie },
    payload: body,
  });
  assert.equal(response.statusCode, 201, response.payload);
  const parsed = response.json() as { invite: { id: string }; link: string };
  const token = parsed.link.split('/').at(-1) ?? '';
  return { id: parsed.invite.id, link: parsed.link, token };
}

interface PublicStepShape {
  key: string;
  pending: boolean;
  fields: Array<{
    key: string;
    kind: string;
    required: boolean;
    options?: Array<{ value: string }>;
    min?: number;
    max?: number;
  }>;
}

interface PublicStateShape {
  status: string;
  phase: string;
  step: PublicStepShape | null;
  progress: number;
  answers: Record<string, unknown>;
  canComplete: boolean;
  report: unknown;
  ideas: Array<{ id: string }>;
}

async function getState(ctx: TestApp, token: string): Promise<PublicStateShape> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/discovery/public/${token}`,
  });
  assert.ok(response.statusCode === 200 || response.statusCode === 410, response.payload);
  return response.json() as PublicStateShape;
}

function answerFor(field: PublicStepShape['fields'][number]): unknown {
  switch (field.kind) {
    case 'text':
      return 'Eine ausführliche Antwort aus dem Test.';
    case 'single':
    case 'scale':
      return field.options?.[0]?.value ?? 'one';
    case 'multi':
      return field.options && field.options.length > 0 ? [field.options[0]?.value] : [];
    case 'rank':
      return (field.options ?? []).map((option) => option.value);
    case 'number':
      return field.min ?? 5;
    case 'yesno':
      return true;
    default:
      return 'Antwort';
  }
}

async function postAnswers(
  ctx: TestApp,
  token: string,
  entries: Array<{ key: string; value: unknown }>,
): Promise<{ statusCode: number; state: PublicStateShape; body: unknown }> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/discovery/public/${token}/answers`,
    payload: { answers: entries },
  });
  const body = response.json() as unknown;
  return {
    statusCode: response.statusCode,
    state: response.statusCode < 300 ? (body as PublicStateShape) : ({} as PublicStateShape),
    body,
  };
}

async function advance(
  ctx: TestApp,
  token: string,
  body: Record<string, unknown> = {},
): Promise<{ statusCode: number; state: PublicStateShape; body: unknown }> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/discovery/public/${token}/advance`,
    payload: body,
  });
  const parsed = response.json() as { state?: PublicStateShape; hint?: unknown } & {
    error?: unknown;
  };
  return {
    statusCode: response.statusCode,
    state: response.statusCode < 300 && parsed.state ? parsed.state : ({} as PublicStateShape),
    body: parsed,
  };
}

/** Runs the interview from consent to the confirmation step. */
async function runInterview(ctx: TestApp, token: string): Promise<void> {
  for (let guard = 0; guard < 80; guard += 1) {
    const state = await getState(ctx, token);
    if (state.phase === 'confirm' && state.step === null) return;
    const step = state.step;
    assert.ok(step, `expected a step in phase ${state.phase}`);
    const entries = step.fields
      .filter((field) => field.required || (field.kind === 'multi' && field.options?.length))
      .map((field) => ({
        key: field.key,
        value:
          field.key === 'clusters.selected'
            ? ['A', 'B', 'C']
            : field.kind === 'multi' && field.options?.length === 0
              ? []
              : answerFor(field),
      }));
    if (entries.length > 0) {
      const saved = await postAnswers(ctx, token, entries);
      assert.equal(saved.statusCode, 200, JSON.stringify(saved.state));
    }
    const moved = await advance(ctx, token);
    assert.equal(moved.statusCode, 200, JSON.stringify(moved.state));
  }
  throw new Error('interview did not reach the confirmation phase');
}

test('operator routes need a session and the operator role', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());

  const anonymous = await ctx.app.inject({ method: 'GET', url: '/api/v1/discovery/invites' });
  assert.equal(anonymous.statusCode, 401);

  const admin = await ctx.signIn('tenant.admin@example.test', 'tenant_admin');
  const adminResponse = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/discovery/invites',
    headers: { cookie: admin },
  });
  assert.equal(adminResponse.statusCode, 403);

  const employee = await ctx.signIn('employee@example.test', 'employee');
  const employeeResponse = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/discovery/invites',
    headers: { cookie: employee },
  });
  assert.equal(employeeResponse.statusCode, 403);
});

test('creating an invite returns the link once and stores only the token hash', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();

  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/discovery/invites',
    headers: { cookie },
    payload: { customerName: 'Muster GmbH', contactEmail: 'kunde@example.test', locale: 'de' },
  });
  assert.equal(response.statusCode, 201, response.payload);
  const body = response.json() as {
    invite: Record<string, unknown>;
    link: string;
    mailSent: boolean;
  };
  const token = body.link.split('/').at(-1) ?? '';
  assert.equal(token.length, 43);
  assert.match(body.link, /^http:\/\/127\.0\.0\.1:5273\/d\/[A-Za-z0-9_-]{43}$/);
  assert.equal(body.mailSent, false);
  assert.equal(JSON.stringify(body.invite).includes(token), false);

  const row = ctx.db
    .prepare('select * from discovery_invite where id = ?')
    .get((body.invite as { id: string }).id) as Record<string, unknown>;
  assert.equal(row.token_hash, createHash('sha256').update(token).digest('hex'));
  assert.equal(JSON.stringify(row).includes(token), false);

  const list = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/discovery/invites',
    headers: { cookie },
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.body.includes(token), false);
  assert.equal(list.body.includes('/d/'), false);
});

test('public state works without a session and carries the security headers', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);

  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/discovery/public/${invite.token}`,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['x-robots-tag'], 'noindex, nofollow');
  const state = response.json() as PublicStateShape;
  assert.equal(state.step?.key, 'consent');
  assert.equal(state.step?.fields[0]?.key, 'consent');

  const unknown = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/discovery/public/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });
  assert.equal(unknown.statusCode, 404);
  assert.equal(
    (unknown.json() as { error: { code: string } }).error.code,
    'discovery_invite_not_found',
  );
});

test('answers are saved per question and the interview resumes at the next step', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);

  const consent = await postAnswers(ctx, invite.token, [{ key: 'consent', value: true }]);
  assert.equal(consent.statusCode, 200);
  const moved = await advance(ctx, invite.token);
  assert.equal(moved.statusCode, 200);
  assert.equal(moved.state.step?.key, 'map.q1');

  const saved = await postAnswers(ctx, invite.token, [
    { key: 'map.q1', value: 'Maschinenbau mit 40 Mitarbeitenden.' },
  ]);
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.state.answers['map.q1'], 'Maschinenbau mit 40 Mitarbeitenden.');

  // A second write to the same key updates instead of duplicating.
  await postAnswers(ctx, invite.token, [
    { key: 'map.q1', value: 'Maschinenbau, 45 Mitarbeitende.' },
  ]);
  const rows = ctx.db
    .prepare("select count(*) as total from discovery_answer where question_key = 'map.q1'")
    .get() as { total: number };
  assert.equal(rows.total, 1);

  const resumed = await getState(ctx, invite.token);
  assert.equal(resumed.step?.key, 'map.q1');
  assert.equal(resumed.answers['map.q1'], 'Maschinenbau, 45 Mitarbeitende.');
  assert.ok(resumed.progress > 0);
});

test('validation rejects unknown keys, wrong types and overlong free text', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);
  await postAnswers(ctx, invite.token, [{ key: 'consent', value: true }]);
  await advance(ctx, invite.token);

  const foreign = await postAnswers(ctx, invite.token, [{ key: 'map.q9.level', value: 'none' }]);
  assert.equal(foreign.statusCode, 422);
  assert.ok(
    (foreign.body as { error: { fields: Record<string, string> } }).error.fields['map.q9.level'],
  );

  const wrongType = await postAnswers(ctx, invite.token, [{ key: 'map.q1', value: 42 }]);
  assert.equal(wrongType.statusCode, 422);

  const tooLong = await postAnswers(ctx, invite.token, [
    { key: 'map.q1', value: 'x'.repeat(4001) },
  ]);
  assert.equal(tooLong.statusCode, 422);
});

test('the public routes are rate limited per token and sender', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);

  let limited: {
    statusCode: number;
    headers: Record<string, unknown>;
    json: () => unknown;
  } | null = null;
  for (let index = 0; index < 241; index += 1) {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/discovery/public/${invite.token}`,
    });
    if (response.statusCode === 429) limited = response;
  }
  assert.ok(limited, 'the request past the budget is rejected');
  assert.equal(limited.headers['retry-after'], '60');
  assert.equal((limited.json() as { error: { code: string } }).error.code, 'rate_limited');
});

test('revoking and rotating a link invalidate the old token', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);

  const rotated = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/discovery/invites/${invite.id}/resend`,
    headers: { cookie },
  });
  assert.equal(rotated.statusCode, 200);
  const newToken = ((rotated.json() as { link: string }).link.split('/').at(-1) ?? '') as string;
  assert.notEqual(newToken, invite.token);

  const oldLink = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/discovery/public/${invite.token}`,
  });
  assert.equal(oldLink.statusCode, 404);
  const newLink = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/discovery/public/${newToken}`,
  });
  assert.equal(newLink.statusCode, 200);

  const revoked = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/discovery/invites/${invite.id}/revoke`,
    headers: { cookie },
  });
  assert.equal(revoked.statusCode, 200);
  const after = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/discovery/public/${newToken}`,
  });
  assert.equal(after.statusCode, 410);
  assert.equal((after.json() as { error: { code: string } }).error.code, 'discovery_link_revoked');
});

test('an expired link is rejected and a GET never changes the stored status', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);
  ctx.db
    .prepare('update discovery_invite set expires_at = ? where id = ?')
    .run('2020-01-01T00:00:00.000Z', invite.id);

  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/discovery/public/${invite.token}`,
  });
  assert.equal(response.statusCode, 410);
  assert.equal(
    (response.json() as { error: { code: string } }).error.code,
    'discovery_link_expired',
  );
  const row = ctx.db.prepare('select status from discovery_invite where id = ?').get(invite.id) as {
    status: string;
  };
  assert.equal(row.status, 'open');

  const write = await postAnswers(ctx, invite.token, [{ key: 'consent', value: true }]);
  assert.equal(write.statusCode, 410);

  const complete = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/discovery/public/${invite.token}/complete`,
  });
  assert.equal(complete.statusCode, 410);
  assert.equal(
    (complete.json() as { error: { code: string } }).error.code,
    'discovery_link_expired',
  );
  const afterWrite = ctx.db
    .prepare('select status from discovery_invite where id = ?')
    .get(invite.id) as { status: string };
  assert.equal(afterWrite.status, 'expired');
});

test('an invite can reference an existing tenant only', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const tenantResponse = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/tenants',
    headers: { cookie },
    payload: { name: 'Beispiel GmbH' },
  });
  const tenant = tenantResponse.json() as { id: string };

  const unknown = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/discovery/invites',
    headers: { cookie },
    payload: { customerName: 'Muster GmbH', tenantId: 'tnt_missing' },
  });
  assert.equal(unknown.statusCode, 422);

  const valid = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/discovery/invites',
    headers: { cookie },
    payload: { customerName: 'Muster GmbH', tenantId: tenant.id },
  });
  assert.equal(valid.statusCode, 201);
  assert.equal((valid.json() as { invite: { tenantId: string } }).invite.tenantId, tenant.id);
});

test('the full interview completes and stores exactly one validated report', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  stubLlm(ctx, llmReply);
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);

  await runInterview(ctx, invite.token);

  const confirm = await getState(ctx, invite.token);
  assert.equal(confirm.phase, 'confirm');
  assert.equal(confirm.canComplete, true);
  assert.deepEqual(confirm.answers['clusters.selected'], ['A', 'B', 'C']);

  const completed = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/discovery/public/${invite.token}/complete`,
  });
  assert.equal(completed.statusCode, 200, completed.payload);
  const state = completed.json() as PublicStateShape & {
    status: string;
    report: { summary: string };
  };
  assert.equal(state.status, 'completed');
  assert.equal(state.report.summary, GOOD_REPORT.summary);
  assert.equal(state.progress, 100);

  const again = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/discovery/public/${invite.token}/complete`,
  });
  assert.equal(again.statusCode, 200);
  const counts = ctx.db.prepare('select count(*) as total from discovery_report').get() as {
    total: number;
  };
  assert.equal(counts.total, 1);

  const readBack = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/discovery/public/${invite.token}`,
  });
  assert.equal(readBack.statusCode, 410);
  const readState = readBack.json() as { status: string; report: { summary: string } };
  assert.equal(readState.status, 'completed');
  assert.equal(readState.report.summary, GOOD_REPORT.summary);

  const afterComplete = await postAnswers(ctx, invite.token, [
    { key: 'confirm.summary.ok', value: true },
  ]);
  assert.equal(afterComplete.statusCode, 409);

  const operatorReport = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/discovery/invites/${invite.id}/report`,
    headers: { cookie },
  });
  assert.equal(operatorReport.statusCode, 200);
  const operatorBody = operatorReport.json() as {
    report: { opportunities: Array<{ title: string }> };
    model: string;
  };
  assert.equal(operatorBody.report.opportunities.length, 2);
  assert.equal(operatorBody.model, 'test-model');
});

test('a provider outage keeps answers and lets the customer retry', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);

  stubLlm(ctx, () => ({
    status: 503,
    body: JSON.stringify({ error: { code: 'llm_provider_error', message: 'down' } }),
  }));

  await postAnswers(ctx, invite.token, [{ key: 'consent', value: true }]);
  const started = await advance(ctx, invite.token);
  assert.equal(started.statusCode, 200);
  await postAnswers(ctx, invite.token, [{ key: 'map.q1', value: 'Maschinenbau.' }]);
  const blocked = await advance(ctx, invite.token);
  assert.equal(blocked.statusCode, 503);
  assert.equal(
    (
      (
        await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/discovery/public/${invite.token}/advance`,
          payload: {},
        })
      ).json() as { error: { code: string } }
    ).error.code,
    'discovery_ai_unavailable',
  );

  const resumed = await getState(ctx, invite.token);
  assert.equal(resumed.answers['consent'], true);
  assert.equal(resumed.step?.key, 'map.q1');
});

test('a broken model output never becomes a report', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);
  stubLlm(ctx, (payload) => {
    const reply = llmReply(payload);
    if (JSON.stringify(payload).includes('structured automation assessment')) {
      return {
        status: 200,
        body: JSON.stringify({
          message: { content: JSON.stringify({ summary: 'Zu kurz' }) },
          model: { modelKey: 'broken' },
        }),
      };
    }
    return reply;
  });

  await runInterview(ctx, invite.token);
  const completed = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/discovery/public/${invite.token}/complete`,
  });
  assert.equal(completed.statusCode, 502);
  assert.equal(
    (completed.json() as { error: { code: string } }).error.code,
    'discovery_analysis_invalid',
  );
  const reports = ctx.db.prepare('select count(*) as total from discovery_report').get() as {
    total: number;
  };
  assert.equal(reports.total, 0);
  const inviteRow = ctx.db
    .prepare('select status from discovery_invite where id = ?')
    .get(invite.id) as { status: string };
  assert.equal(inviteRow.status, 'in_progress');
});

test('a report cut off twice answers with its own code, not a schema error', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);
  stubLlm(ctx, (payload) => {
    const hit = JSON.stringify(payload).includes('structured automation assessment');
    if (!hit) return llmReply(payload);
    return {
      status: 200,
      body: JSON.stringify({
        message: { content: '{"summary":"Das Unternehmen verliert Zeit bei Ange' },
        model: { modelKey: 'test-model' },
        finishReason: 'length',
      }),
    };
  });

  await runInterview(ctx, invite.token);
  const completed = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/discovery/public/${invite.token}/complete`,
  });
  assert.equal(completed.statusCode, 502);
  const error = (completed.json() as { error: { code: string; reason?: string } }).error;
  assert.equal(error.code, 'discovery_ai_truncated');
  assert.equal(error.reason, 'truncated');
  const reports = ctx.db.prepare('select count(*) as total from discovery_report').get() as {
    total: number;
  };
  assert.equal(reports.total, 0);
});

test('a filtered answer is not retried, because the same filter would stop it again', async () => {
  let calls = 0;
  const call = async () => {
    calls += 1;
    return {
      status: 200,
      body: JSON.stringify({
        message: { content: '' },
        model: { modelKey: 'test-model' },
        finishReason: 'content_filter',
      }),
    };
  };
  const warnings: string[] = [];
  await assert.rejects(
    () =>
      analyse(call, {
        locale: 'de',
        customerName: 'Test GmbH',
        selectedClusters: ['A'],
        answers: [],
        log: { warn: (_obj, message) => warnings.push(message) },
      }),
    (error: unknown) => error instanceof AiUnavailable && error.reason === 'filtered',
  );
  // One paid call, not two: a retry with the same prompt and policy is
  // filtered again and only costs money.
  assert.equal(calls, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /content filter/);
});

test('a filtered answer reaches the customer with its own code, not a budget message', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);
  stubLlm(ctx, (payload) => {
    const hit = JSON.stringify(payload).includes('structured automation assessment');
    if (!hit) return llmReply(payload);
    return {
      status: 200,
      body: JSON.stringify({
        message: { content: '' },
        model: { modelKey: 'test-model' },
        finishReason: 'content_filter',
      }),
    };
  });

  await runInterview(ctx, invite.token);
  const completed = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/discovery/public/${invite.token}/complete`,
  });
  assert.equal(completed.statusCode, 422);
  const error = (completed.json() as { error: { code: string; reason?: string } }).error;
  assert.equal(error.code, 'discovery_ai_filtered');
  assert.equal(error.reason, 'filtered');
});

test('a filter refusal on the retry is filtered, not a schema error', async () => {
  // First answer is cut off with unusable JSON, so the retry runs; the retry
  // then comes back filtered. That is a refusal, not a broken schema.
  let calls = 0;
  const call = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        status: 200,
        body: JSON.stringify({
          message: { content: '{"summary":"Das Unternehmen verliert Zeit bei Ange' },
          model: { modelKey: 'test-model' },
          finishReason: 'length',
        }),
      };
    }
    return {
      status: 200,
      body: JSON.stringify({
        message: { content: '' },
        model: { modelKey: 'test-model' },
        finishReason: 'content_filter',
      }),
    };
  };
  const warnings: string[] = [];
  await assert.rejects(
    () =>
      analyse(call, {
        locale: 'de',
        customerName: 'Test GmbH',
        selectedClusters: ['A'],
        answers: [],
        log: { warn: (_obj, message) => warnings.push(message) },
      }),
    (error: unknown) => error instanceof AiUnavailable && error.reason === 'filtered',
  );
  // Two paid calls: the truncation retry, then the filter stops it for good.
  assert.equal(calls, 2);
  assert.ok(warnings.some((line) => /retry was refused by the content filter/.test(line)));
});

test('a filtered hint keeps the step usable instead of blocking the interview', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);

  let filtered = true;
  stubLlm(ctx, (payload) => {
    const request = payload as { messages?: Array<{ content?: string }> } | undefined;
    const system = request?.messages?.[0]?.content ?? '';
    if (system.includes('structured automation assessment')) return llmReply(payload);
    if (system.includes('pick automation topics')) return llmReply(payload);
    if (!filtered) return llmReply(payload);
    return {
      status: 200,
      body: JSON.stringify({
        message: { content: '' },
        model: { modelKey: 'test-model' },
        finishReason: 'content_filter',
      }),
    };
  });

  await postAnswers(ctx, invite.token, [{ key: 'consent', value: true }]);
  const opened = await advance(ctx, invite.token);
  assert.equal(opened.statusCode, 200);

  // The hint is filtered. That is a comfort feature, so the step still moves
  // on: no 422, no blocked question, nothing stored that locks the link.
  const withoutHint = await advance(ctx, invite.token);
  assert.equal(withoutHint.statusCode, 200);
  assert.equal((withoutHint.body as { hint?: unknown }).hint, null);
  const state = await getState(ctx, invite.token);
  assert.equal(state.phase, 'map');
  assert.notEqual(state.step?.key, 'consent');

  // The very same step works again as soon as the model answers normally.
  filtered = false;
  const withHint = await advance(ctx, invite.token);
  assert.equal(withHint.statusCode, 200);
  const hint = (withHint.body as { hint?: { text: string } | null }).hint;
  assert.ok(hint && hint.text.length > 0);
});

test('isFiltered recognises the filter and isTruncated no longer claims it', () => {
  assert.equal(isFiltered('content_filter'), true);
  assert.equal(isFiltered('CONTENT_FILTER'), true);
  assert.equal(isFiltered('length'), false);
  assert.equal(isTruncated('content_filter'), false);
  assert.equal(isTruncated('length'), true);
});

test('an empty reasoning answer becomes truncated, not a schema error', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);
  let analysisCalls = 0;
  stubLlm(ctx, (payload) => {
    const hit = JSON.stringify(payload).includes('structured automation assessment');
    if (!hit) return llmReply(payload);
    analysisCalls += 1;
    // A reasoning model that spends the whole budget before writing any JSON.
    return {
      status: 200,
      body: JSON.stringify({
        message: { content: '' },
        model: { modelKey: 'test-model' },
        finishReason: 'length',
      }),
    };
  });

  await runInterview(ctx, invite.token);
  const completed = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/discovery/public/${invite.token}/complete`,
  });
  assert.equal(completed.statusCode, 502);
  const error = (completed.json() as { error: { code: string; reason?: string } }).error;
  assert.equal(error.code, 'discovery_ai_truncated');
  assert.equal(error.reason, 'truncated');
  // One retry, then the defined error: not the old schema message.
  assert.equal(analysisCalls, 2);
});

test('a failed configuration attempt costs nothing, and a new link resets the budget', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);

  // The analysis purpose is unmapped, so the provider answers 409 before any
  // model call; the interview hints keep working.
  stubLlm(ctx, (payload) => {
    if (JSON.stringify(payload).includes('structured automation assessment')) {
      return { status: 409, body: JSON.stringify({ error: { code: 'llm_purpose_unmapped' } }) };
    }
    return llmReply(payload);
  });

  await runInterview(ctx, invite.token);

  for (let index = 0; index < 6; index += 1) {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/discovery/public/${invite.token}/complete`,
    });
    assert.equal(response.statusCode, 503);
    assert.equal(
      (response.json() as { error: { reason?: string } }).error.reason,
      'not_configured',
    );
  }
  const attempts = () =>
    (
      ctx.db
        .prepare('select complete_attempts from discovery_session where invite_id = ?')
        .get(invite.id) as { complete_attempts: number }
    ).complete_attempts;
  // Six configuration failures spend nothing: the model was never called, so
  // the customer must not be locked out.
  assert.equal(attempts(), 0);

  // A rotated link starts the budget over as well.
  ctx.db
    .prepare('update discovery_session set complete_attempts = ? where invite_id = ?')
    .run(COMPLETE_ATTEMPT_LIMIT, invite.id);
  const rotated = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/discovery/invites/${invite.id}/resend`,
    headers: { cookie },
  });
  assert.equal(rotated.statusCode, 200);
  assert.equal(attempts(), 0);
});

test('repeating the same interview step stops at the step budget, not at 25 calls', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);

  let hintCalls = 0;
  stubLlm(ctx, (payload) => {
    const request = payload as { messages?: Array<{ content?: string }> } | undefined;
    const system = request?.messages?.[0]?.content ?? '';
    if (system.includes('structured automation assessment')) return llmReply(payload);
    if (system.includes('pick automation topics')) return llmReply(payload);
    hintCalls += 1;
    // A counted failure: the model answered but produced nothing usable, so
    // the step stays and every request serves the same question. This is the
    // cheap loop the security review measured.
    return {
      status: 200,
      body: JSON.stringify({
        message: { content: '' },
        model: { modelKey: 'test-model' },
        finishReason: 'stop',
      }),
    };
  });

  // Into the map phase: consent, then the first question is opened.
  await postAnswers(ctx, invite.token, [{ key: 'consent', value: true }]);
  assert.equal((await advance(ctx, invite.token)).statusCode, 200);

  const statuses: number[] = [];
  for (let index = 0; index < 25; index += 1) {
    statuses.push((await advance(ctx, invite.token)).statusCode);
  }
  // 25 requests, exactly STEP_ATTEMPT_LIMIT provider calls, then 429 for the
  // rest: the loop no longer scales with requests.
  assert.equal(hintCalls, STEP_ATTEMPT_LIMIT);
  assert.equal(
    statuses.slice(0, STEP_ATTEMPT_LIMIT).every((status) => status === 502),
    true,
  );
  assert.equal(
    statuses.slice(STEP_ATTEMPT_LIMIT).every((status) => status === 429),
    true,
  );

  // A hard failure keeps the step blocked: the operator sees why.
  const step = ctx.db
    .prepare('select ai_step_key, ai_step_attempts from discovery_session')
    .get() as { ai_step_key: string | null; ai_step_attempts: number };
  assert.ok(step.ai_step_key);
  assert.equal(step.ai_step_attempts, STEP_ATTEMPT_LIMIT);
});

test('a provider outage on one step does not lock that step for the customer', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);

  let providerDown = true;
  let hintCalls = 0;
  stubLlm(ctx, (payload) => {
    const request = payload as { messages?: Array<{ content?: string }> } | undefined;
    const system = request?.messages?.[0]?.content ?? '';
    if (system.includes('structured automation assessment')) return llmReply(payload);
    if (system.includes('pick automation topics')) return llmReply(payload);
    hintCalls += 1;
    if (!providerDown) return llmReply(payload);
    return { status: 503, body: JSON.stringify({ error: { code: 'llm_provider_error' } }) };
  });

  await postAnswers(ctx, invite.token, [{ key: 'consent', value: true }]);
  assert.equal((await advance(ctx, invite.token)).statusCode, 200);

  // Five provider outages on the same question: no answer, so nothing is
  // spent and the question stays usable.
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await advance(ctx, invite.token)).statusCode, 503);
  }
  assert.equal(hintCalls, 5);

  providerDown = false;
  const recovered = await advance(ctx, invite.token);
  assert.equal(recovered.statusCode, 200);
  assert.ok((recovered.body as { hint?: { text: string } | null }).hint);
});

test('a successful answer gives the question a fresh allowance when it comes back', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);

  let mode: 'ok' | 'fail' = 'ok';
  let hintCalls = 0;
  stubLlm(ctx, (payload) => {
    const request = payload as { messages?: Array<{ content?: string }> } | undefined;
    const system = request?.messages?.[0]?.content ?? '';
    if (system.includes('structured automation assessment')) return llmReply(payload);
    if (system.includes('pick automation topics')) return llmReply(payload);
    hintCalls += 1;
    if (mode === 'ok') return llmReply(payload);
    // A counted failure, so the step counter fills instead of being refunded.
    return {
      status: 200,
      body: JSON.stringify({
        message: { content: '' },
        model: { modelKey: 'test-model' },
        finishReason: 'stop',
      }),
    };
  });

  await postAnswers(ctx, invite.token, [{ key: 'consent', value: true }]);
  assert.equal((await advance(ctx, invite.token)).statusCode, 200);
  // The successful answer closed the question: nothing left over.
  const after = ctx.db
    .prepare('select current_step, ai_step_key, ai_step_attempts from discovery_session')
    .get() as { current_step: number; ai_step_key: string | null; ai_step_attempts: number };
  assert.equal(after.ai_step_key, null);
  assert.equal(after.ai_step_attempts, 0);

  // A revisit of the same question (an operator going back, `deepen` returning
  // to a question) must start with a full allowance, not inherit the old count.
  ctx.db.prepare('update discovery_session set current_step = ?').run(after.current_step - 1);
  mode = 'fail';
  const before = hintCalls;
  for (let index = 0; index < STEP_ATTEMPT_LIMIT; index += 1) {
    assert.equal((await advance(ctx, invite.token)).statusCode, 502);
  }
  // Four model calls, not an immediate 429: the allowance is fresh.
  assert.equal(hintCalls - before, STEP_ATTEMPT_LIMIT);
  assert.equal((await advance(ctx, invite.token)).statusCode, 429);
});

test('the whole AI budget of a link is what stops an endless interview', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);

  // Three counted failures, then a good answer, on every question: four real
  // model calls per question, so the interview walks the map and spends its
  // budget at the honest rate, without the step cap ever blocking a question.
  let failures = 0;
  let hintCalls = 0;
  stubLlm(ctx, (payload) => {
    const request = payload as { messages?: Array<{ content?: string }> } | undefined;
    const system = request?.messages?.[0]?.content ?? '';
    if (system.includes('structured automation assessment')) return llmReply(payload);
    if (system.includes('pick automation topics')) return llmReply(payload);
    hintCalls += 1;
    if (failures >= 3) {
      failures = 0;
      return llmReply(payload);
    }
    failures += 1;
    return {
      status: 200,
      body: JSON.stringify({
        message: { content: '' },
        model: { modelKey: 'test-model' },
        finishReason: 'stop',
      }),
    };
  });

  await postAnswers(ctx, invite.token, [{ key: 'consent', value: true }]);
  assert.equal((await advance(ctx, invite.token)).statusCode, 200);

  const budget = aiAttemptLimit('standard');
  let advanced = 0;
  for (let guard = 0; guard < 60 && hintCalls < budget; guard += 1) {
    const response = await advance(ctx, invite.token);
    assert.ok(
      response.statusCode === 200 || response.statusCode === 502,
      `unexpected ${response.statusCode}: ${JSON.stringify(response.body)}`,
    );
    if (response.statusCode === 200) advanced += 1;
  }
  // The honest interview spent the budget in model calls, not in requests.
  assert.equal(hintCalls, budget);
  assert.ok(advanced >= 11, `only ${advanced} questions were passed`);

  // The next request is refused by the total budget, and it costs nothing.
  const exhausted = await advance(ctx, invite.token);
  assert.equal(exhausted.statusCode, 429);
  assert.equal(
    (exhausted.body as { error: { code: string } }).error.code,
    'discovery_complete_limit_reached',
  );
  assert.equal(hintCalls, budget);
});

test('the operator sees why a step is blocked, not just a 429', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);

  stubLlm(ctx, (payload) => {
    const request = payload as { messages?: Array<{ content?: string }> } | undefined;
    const system = request?.messages?.[0]?.content ?? '';
    if (system.includes('structured automation assessment')) return llmReply(payload);
    if (system.includes('pick automation topics')) return llmReply(payload);
    return {
      status: 200,
      body: JSON.stringify({
        message: { content: '' },
        model: { modelKey: 'test-model' },
        finishReason: 'stop',
      }),
    };
  });

  await postAnswers(ctx, invite.token, [{ key: 'consent', value: true }]);
  await advance(ctx, invite.token);
  for (let index = 0; index < STEP_ATTEMPT_LIMIT; index += 1) {
    await advance(ctx, invite.token);
  }
  assert.equal((await advance(ctx, invite.token)).statusCode, 429);

  const detail = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/discovery/invites/${invite.id}`,
    headers: { cookie },
  });
  assert.equal(detail.statusCode, 200);
  const session = (
    detail.json() as {
      invite: {
        session: { aiStepAttempts: number; stepBlocked: boolean; aiAttempts: number } | null;
      };
    }
  ).invite.session;
  assert.ok(session);
  // The operator sees the cause: this question used up its allowance.
  assert.equal(session.stepBlocked, true);
  assert.equal(session.aiStepAttempts, STEP_ATTEMPT_LIMIT);
});

test('repeated complete calls stop at the attempt limit, and a report still wins', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);

  let analysisCalls = 0;
  let breakAnalysis = true;
  stubLlm(ctx, (payload) => {
    const hit = JSON.stringify(payload).includes('structured automation assessment');
    if (!hit) return llmReply(payload);
    analysisCalls += 1;
    if (breakAnalysis) {
      return {
        status: 200,
        body: JSON.stringify({
          message: { content: '{"summary":"Das Unternehmen verliert Zeit' },
          model: { modelKey: 'test-model' },
          finishReason: 'length',
        }),
      };
    }
    return llmReply(payload);
  });

  await runInterview(ctx, invite.token);
  const complete = () =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/discovery/public/${invite.token}/complete`,
    });

  // Each failing attempt is two provider calls (first answer plus the doubled
  // retry) and leaves no report. Without a counter one link could go on
  // forever.
  const refused: number[] = [];
  for (let index = 0; index < 7; index += 1) {
    const response = await complete();
    if (response.statusCode === 429) refused.push(index);
    else assert.equal(response.statusCode, 502);
  }
  assert.deepEqual(refused, [5, 6]);
  const overLimit = await complete();
  assert.equal(overLimit.statusCode, 429);
  assert.equal(
    (overLimit.json() as { error: { code: string } }).error.code,
    'discovery_complete_limit_reached',
  );
  // Five refused attempts, each two provider calls, then no call at all.
  assert.equal(analysisCalls, 10);

  // A report that already exists is still delivered: the limit must not hide
  // it, and it must not need another model call.
  breakAnalysis = false;
  ctx.db
    .prepare('update discovery_session set complete_attempts = 0 where invite_id = ?')
    .run(invite.id);
  const created = await complete();
  assert.equal(created.statusCode, 200);
  const reports = ctx.db.prepare('select count(*) as total from discovery_report').get() as {
    total: number;
  };
  assert.equal(reports.total, 1);

  ctx.db
    .prepare('update discovery_session set complete_attempts = ? where invite_id = ?')
    .run(COMPLETE_ATTEMPT_LIMIT, invite.id);
  const callsBefore = analysisCalls;
  const again = await complete();
  assert.equal(again.statusCode, 200);
  assert.equal(analysisCalls, callsBefore);
});

test('a provider outage costs no budget, so the link still works afterwards', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);

  let providerDown = true;
  stubLlm(ctx, (payload) => {
    if (!JSON.stringify(payload).includes('structured automation assessment')) {
      return llmReply(payload);
    }
    if (providerDown) {
      return { status: 503, body: JSON.stringify({ error: { code: 'llm_provider_error' } }) };
    }
    return llmReply(payload);
  });

  await runInterview(ctx, invite.token);
  const complete = () =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/discovery/public/${invite.token}/complete`,
    });
  const counters = () =>
    ctx.db
      .prepare('select complete_attempts, ai_attempts from discovery_session where invite_id = ?')
      .get(invite.id) as { complete_attempts: number; ai_attempts: number };

  // The provider is down for six requests. None of them produced an answer, so
  // none of them may cost the link its budget.
  for (let index = 0; index < 6; index += 1) {
    const failed = await complete();
    assert.equal(failed.statusCode, 503);
    assert.equal((failed.json() as { error: { reason?: string } }).error.reason, 'unavailable');
  }
  assert.equal(counters().complete_attempts, 0);

  providerDown = false;
  const recovered = await complete();
  assert.equal(recovered.statusCode, 200);
  assert.equal(counters().complete_attempts, 1);
});

test('five real assessments still use up the assessment budget', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);

  let analysisCalls = 0;
  stubLlm(ctx, (payload) => {
    if (!JSON.stringify(payload).includes('structured automation assessment')) {
      return llmReply(payload);
    }
    analysisCalls += 1;
    // Answers, but with unusable JSON: each call is paid for and leaves no
    // report, which is exactly what the budget has to limit.
    return {
      status: 200,
      body: JSON.stringify({
        message: { content: JSON.stringify({ summary: 'Zu kurz' }) },
        model: { modelKey: 'test-model' },
      }),
    };
  });

  await runInterview(ctx, invite.token);
  const complete = () =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/discovery/public/${invite.token}/complete`,
    });

  const statuses: number[] = [];
  for (let index = 0; index < 6; index += 1) {
    statuses.push((await complete()).statusCode);
  }
  assert.deepEqual(statuses, [502, 502, 502, 502, 502, 429]);
  // Five paid model calls, then not one more.
  assert.equal(analysisCalls, 5);
});

test('the operator sees the AI budget of a link, so a 429 is diagnosable', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);

  // Hints and the assessment use the same model; the assessment answers with
  // unusable JSON so one paid call is counted.
  let analysis = false;
  stubLlm(ctx, (payload) => {
    if (!JSON.stringify(payload).includes('structured automation assessment') && !analysis) {
      return llmReply(payload);
    }
    analysis = true;
    return {
      status: 200,
      body: JSON.stringify({
        message: { content: JSON.stringify({ summary: 'Zu kurz' }) },
        model: { modelKey: 'test-model' },
      }),
    };
  });
  await runInterview(ctx, invite.token);
  await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/discovery/public/${invite.token}/complete`,
  });

  const detail = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/discovery/invites/${invite.id}`,
    headers: { cookie },
  });
  assert.equal(detail.statusCode, 200);
  const session = (
    detail.json() as {
      invite: { session: { aiAttempts: number; assessmentAttempts: number } | null };
    }
  ).invite.session;
  assert.ok(session);
  assert.equal(session.assessmentAttempts, 1);
  // The interview hints are part of the same budget, so the total is higher.
  assert.ok(session.aiAttempts > session.assessmentAttempts);
});

test('the short check skips the deep phase unless the operator forces full', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  stubLlm(ctx, llmReply);
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie, {
    customerName: 'Kurzcheck GmbH',
    mode: 'standard',
  });

  await postAnswers(ctx, invite.token, [{ key: 'consent', value: true }]);
  await advance(ctx, invite.token);
  for (let index = 0; index < 12; index += 1) {
    const state = await getState(ctx, invite.token);
    assert.ok(state.step);
    const entries = state.step.fields
      .filter((field) => field.required)
      .map((field) => ({ key: field.key, value: answerFor(field) }));
    await postAnswers(ctx, invite.token, entries);
    const moved = await advance(ctx, invite.token, index === 11 ? { shortcut: true } : {});
    assert.equal(moved.statusCode, 200, JSON.stringify(moved.state));
  }
  const state = await getState(ctx, invite.token);
  assert.equal(state.phase, 'confirm');

  const forced = await createInvite(ctx, cookie, {
    customerName: 'Voll GmbH',
    mode: 'full',
  });
  await postAnswers(ctx, forced.token, [{ key: 'consent', value: true }]);
  await advance(ctx, forced.token);
  for (let index = 0; index < 12; index += 1) {
    const current = await getState(ctx, forced.token);
    assert.ok(current.step);
    await postAnswers(
      ctx,
      forced.token,
      current.step.fields
        .filter((field) => field.required)
        .map((field) => ({ key: field.key, value: answerFor(field) })),
    );
    const moved = await advance(ctx, forced.token, index === 11 ? { shortcut: true } : {});
    assert.equal(moved.statusCode, 200, JSON.stringify(moved.state));
  }
  const forcedState = await getState(ctx, forced.token);
  assert.equal(forcedState.phase, 'clusters');
});

test('free text is stored as data, not rendered, and the log has no token or content', async (t) => {
  const lines: string[] = [];
  const ctx = await createTestApp({}, { logStream: { write: (line) => lines.push(line) } });
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie, {
    customerName: 'Log GmbH',
    contactEmail: 'log@example.test',
  });

  const payload = '<script>alert("xss")</script> und ein Satz.';
  await postAnswers(ctx, invite.token, [{ key: 'consent', value: true }]);
  await advance(ctx, invite.token);
  await postAnswers(ctx, invite.token, [{ key: 'map.q1', value: payload }]);
  await getState(ctx, invite.token);

  const state = await getState(ctx, invite.token);
  assert.equal(state.answers['map.q1'], payload);
  assert.equal(state.step?.key, 'map.q1');
  const raw = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/discovery/public/${invite.token}`,
  });
  assert.match(String(raw.headers['content-type']), /application\/json/);

  const joined = lines.join('\n');
  assert.equal(joined.includes(invite.token), false, 'the token is never logged');
  assert.equal(joined.includes('log@example.test'), false, 'the email is never logged');
  assert.equal(joined.includes('xss'), false, 'free text is never logged');
});

test('the overview counts invites and the list paginates', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  for (const name of ['Alpha GmbH', 'Beta GmbH', 'Gamma GmbH']) {
    await createInvite(ctx, cookie, { customerName: name });
  }

  const page = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/discovery/invites?limit=2',
    headers: { cookie },
  });
  assert.equal(page.statusCode, 200);
  const body = page.json() as { items: unknown[]; total: number; nextCursor: string | null };
  assert.equal(body.items.length, 2);
  assert.equal(body.total, 3);
  assert.ok(body.nextCursor);

  const overview = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/discovery/overview',
    headers: { cookie },
  });
  assert.equal(overview.statusCode, 200);
  const overviewBody = overview.json() as {
    counts: Record<string, number>;
    recent: Array<{ customerName: string }>;
  };
  assert.equal(overviewBody.counts.open, 3);
  assert.equal(overviewBody.recent.length, 3);

  const missing = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/discovery/invites/dvi_missing',
    headers: { cookie },
  });
  assert.equal(missing.statusCode, 404);
});
test('an AI follow-up is asked once, persisted and resumable', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  let followUps = 0;
  stubLlm(ctx, (payload) => {
    const reply = llmReply(payload);
    const messages = (payload as { messages?: Array<{ content?: string }> }).messages ?? [];
    const system = messages[0]?.content ?? '';
    const user = messages[1]?.content ?? '';
    if (
      system.includes('structured automation interview') &&
      user.includes('Phase: deepen') &&
      followUps === 0
    ) {
      followUps += 1;
      return {
        status: 200,
        body: JSON.stringify({
          message: {
            content: JSON.stringify({ hint: 'Kurz genügt.', followUp: 'Wie oft passiert das?' }),
          },
          model: { modelKey: 'test-model' },
        }),
      };
    }
    if (system.includes('structured automation interview')) {
      return {
        status: 200,
        body: JSON.stringify({
          message: { content: JSON.stringify({ hint: 'Kurz genügt.' }) },
          model: { modelKey: 'test-model' },
        }),
      };
    }
    return reply;
  });
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);

  await postAnswers(ctx, invite.token, [{ key: 'consent', value: true }]);
  await advance(ctx, invite.token);
  for (let index = 0; index < 12; index += 1) {
    const state = await getState(ctx, invite.token);
    assert.ok(state.step);
    await postAnswers(
      ctx,
      invite.token,
      state.step.fields
        .filter((field) => field.required)
        .map((field) => ({ key: field.key, value: answerFor(field) })),
    );
    const moved = await advance(ctx, invite.token);
    assert.equal(moved.statusCode, 200, JSON.stringify(moved.state));
  }
  const clusterState = await getState(ctx, invite.token);
  assert.equal(clusterState.phase, 'clusters');
  await postAnswers(ctx, invite.token, [{ key: 'clusters.selected', value: ['A'] }]);
  const deepen = await advance(ctx, invite.token);
  assert.equal(deepen.statusCode, 200, JSON.stringify(deepen.state));
  assert.equal(deepen.state.step?.key, 'deep.A.q1');

  await postAnswers(ctx, invite.token, [
    { key: 'deep.A.q1', value: 'Der Kunde fragt per E-Mail an.' },
  ]);
  const withFollowUp = await advance(ctx, invite.token);
  assert.equal(withFollowUp.statusCode, 200, JSON.stringify(withFollowUp.body));
  assert.equal(withFollowUp.state.step?.key, 'deep.A.fu1');
  assert.equal(withFollowUp.state.step?.pending, true);

  const beforeAnswer = await getState(ctx, invite.token);
  assert.equal(beforeAnswer.step?.key, 'deep.A.fu1');

  await postAnswers(ctx, invite.token, [
    { key: 'deep.A.fu1', value: 'Meist innerhalb eines Tages.' },
  ]);
  const afterAnswer = await advance(ctx, invite.token);
  assert.equal(afterAnswer.statusCode, 200, JSON.stringify(afterAnswer.state));
  assert.equal(afterAnswer.state.step?.key, 'deep.A.q2');
});

test('the idea card shows AI ideas with relevance marks', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  stubLlm(ctx, llmReply);
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);

  await postAnswers(ctx, invite.token, [{ key: 'consent', value: true }]);
  await advance(ctx, invite.token);
  for (let index = 0; index < 12; index += 1) {
    const state = await getState(ctx, invite.token);
    assert.ok(state.step);
    await postAnswers(
      ctx,
      invite.token,
      state.step.fields
        .filter((field) => field.required)
        .map((field) => ({ key: field.key, value: answerFor(field) })),
    );
    await advance(ctx, invite.token);
  }
  await postAnswers(ctx, invite.token, [{ key: 'clusters.selected', value: ['A'] }]);
  await advance(ctx, invite.token);

  for (let index = 1; index <= 7; index += 1) {
    const state = await getState(ctx, invite.token);
    assert.equal(state.step?.key, `deep.A.q${index}`);
    await postAnswers(ctx, invite.token, [
      { key: `deep.A.q${index}`, value: 'Antwort aus dem Test.' },
    ]);
    const moved = await advance(ctx, invite.token);
    assert.equal(moved.statusCode, 200, JSON.stringify(moved.body));
  }

  const ideas = await getState(ctx, invite.token);
  assert.equal(ideas.step?.key, 'deep.A.ideas');
  assert.equal(ideas.ideas.length, 2);
  assert.equal(ideas.step?.fields[0]?.options?.length, 2);

  const marked = await postAnswers(ctx, invite.token, [
    { key: 'deep.A.ideas.relevant', value: [ideas.ideas[0]?.id] },
  ]);
  assert.equal(marked.statusCode, 200);
  assert.deepEqual(marked.state.answers['deep.A.ideas.relevant'], [ideas.ideas[0]?.id]);
});

test('the contact wish is validated and stored', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);

  await postAnswers(ctx, invite.token, [{ key: 'consent', value: true }]);
  await advance(ctx, invite.token);

  const missingWay = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/discovery/public/${invite.token}/contact`,
    payload: { wanted: true },
  });
  assert.equal(missingWay.statusCode, 422);

  const saved = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/discovery/public/${invite.token}/contact`,
    payload: { wanted: true, way: 'Telefon am Vormittag' },
  });
  assert.equal(saved.statusCode, 200);
  const state = saved.json() as PublicStateShape;
  assert.equal(state.answers['confirm.contact.wanted'], true);
  assert.equal(state.answers['confirm.contact.way'], 'Telefon am Vormittag');
});

test('the short check completes without a cluster selection', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  stubLlm(ctx, llmReply);
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie, {
    customerName: 'Kurzcheck GmbH',
    mode: 'short',
  });

  await postAnswers(ctx, invite.token, [{ key: 'consent', value: true }]);
  await advance(ctx, invite.token);
  for (let index = 0; index < 12; index += 1) {
    const state = await getState(ctx, invite.token);
    assert.ok(state.step);
    await postAnswers(
      ctx,
      invite.token,
      state.step.fields
        .filter((field) => field.required)
        .map((field) => ({ key: field.key, value: answerFor(field) })),
    );
    const moved = await advance(ctx, invite.token, index === 11 ? { shortcut: true } : {});
    assert.equal(moved.statusCode, 200, JSON.stringify(moved.state));
  }

  for (let guard = 0; guard < 5; guard += 1) {
    const state = await getState(ctx, invite.token);
    if (!state.step) break;
    await postAnswers(
      ctx,
      invite.token,
      state.step.fields
        .filter((field) => field.required)
        .map((field) => ({ key: field.key, value: answerFor(field) })),
    );
    const moved = await advance(ctx, invite.token);
    assert.equal(moved.statusCode, 200, JSON.stringify(moved.state));
  }

  // No clusters.selected answer exists in the short check; the report must
  // still accept the clusters the model proposed.
  const completed = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/discovery/public/${invite.token}/complete`,
  });
  assert.equal(completed.statusCode, 200, completed.payload);
  const payload = completed.json() as {
    report: { clusters: Array<{ id: string }> } | null;
  };
  assert.ok((payload.report?.clusters.length ?? 0) > 0);
});

test('the full mode counts its deepen steps in the progress', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  stubLlm(ctx, llmReply);
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie, {
    customerName: 'Voll GmbH',
    mode: 'full',
  });

  await postAnswers(ctx, invite.token, [{ key: 'consent', value: true }]);
  await advance(ctx, invite.token);
  for (let index = 0; index < 12; index += 1) {
    const state = await getState(ctx, invite.token);
    assert.ok(state.step);
    await postAnswers(
      ctx,
      invite.token,
      state.step.fields
        .filter((field) => field.required)
        .map((field) => ({ key: field.key, value: answerFor(field) })),
    );
    const moved = await advance(ctx, invite.token);
    assert.equal(moved.statusCode, 200, JSON.stringify(moved.state));
  }

  const clusters = await getState(ctx, invite.token);
  assert.equal(clusters.phase, 'clusters');
  await postAnswers(ctx, invite.token, [{ key: 'clusters.selected', value: ['A', 'B'] }]);
  const moved = await advance(ctx, invite.token);
  assert.equal(moved.statusCode, 200, JSON.stringify(moved.state));
  assert.equal(moved.state.phase, 'deepen');
  // 1 + 12 map + 1 cluster + 2 × 8 deepen + 3 confirm = 33. Without the
  // deepen share the denominator would be 17 and jump to 82 % here.
  assert.ok(moved.state.progress < 70, `progress ${moved.state.progress}`);
});

test('an invitation that expired on read is purged after retention', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);

  const stale = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
  // A GET only reports expiry; the stored status stays 'open'.
  ctx.db
    .prepare('update discovery_invite set expires_at = ?, status = ? where id = ?')
    .run(stale, 'open', invite.id);

  const overview = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/discovery/overview',
    headers: { cookie },
  });
  assert.equal(overview.statusCode, 200, overview.payload);
  const row = ctx.db.prepare('select id from discovery_invite where id = ?').get(invite.id);
  assert.equal(row, undefined);
});

test('the public interview route carries a real OpenAPI summary', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const response = await ctx.app.inject({
    method: 'GET',
    url: '/api/openapi.json',
    headers: { cookie },
  });
  assert.equal(response.statusCode, 200);
  const doc = response.json() as {
    paths: Record<string, Record<string, { summary?: string }>>;
  };
  const summary = doc.paths['/api/v1/discovery/public/{token}']?.get?.summary;
  assert.ok(summary);
  assert.notEqual(summary, 'Public interview state for a link');
  assert.match(summary, /public interview/i);
});

test('overview and list show an invitation as expired without a write', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);
  const stale = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  ctx.db
    .prepare('update discovery_invite set expires_at = ?, status = ? where id = ?')
    .run(stale, 'open', invite.id);

  const overview = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/discovery/overview',
    headers: { cookie },
  });
  assert.equal(overview.statusCode, 200, overview.payload);
  const counts = (overview.json() as { counts: Record<string, number> }).counts;
  assert.equal(counts.expired, 1);
  assert.equal(counts.open, 0);

  const listed = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/discovery/invites?status=expired',
    headers: { cookie },
  });
  assert.equal(listed.statusCode, 200, listed.payload);
  const items = (listed.json() as { items: Array<{ id: string }> }).items;
  assert.ok(items.some((item) => item.id === invite.id));

  const stored = ctx.db
    .prepare('select status from discovery_invite where id = ?')
    .get(invite.id) as { status: string };
  assert.equal(stored.status, 'expired');
});

test('the public rate limiter stays bounded and prunes on a schedule', () => {
  const limiter = new PublicRateLimiter(100, 30_000);
  const start = 1_000_000;
  for (let index = 0; index < 600; index += 1) {
    assert.equal(limiter.allow(`token-${index}`, 240, start), true);
  }
  assert.equal(limiter.size, 100);
  // The newest keys survive; the oldest were evicted.
  assert.equal(limiter.allow('token-599', 240, start), true);
  assert.equal(limiter.allow('token-0', 240, start), true);
  // A later request sweeps keys that fell out of the window.
  assert.equal(limiter.allow('later', 240, start + 61_000), true);
  assert.ok(limiter.size <= 100);
});

test('the public route has a coarse per-IP limit across rotating tokens', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  publicRateLimiter.clear();
  let lastStatus = 0;
  for (let index = 0; index < 5001; index += 1) {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/discovery/public/${`rotating${index}`.padEnd(43, 'x')}`,
      remoteAddress: '203.0.113.77',
    });
    lastStatus = response.statusCode;
  }
  assert.equal(lastStatus, 429);
  // The IP limit runs first, so the flood must not insert 5.001 token buckets.
  assert.ok(publicRateLimiter.size <= 1300, `size ${publicRateLimiter.size}`);
});

test('two parallel completes create exactly one report', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  stubLlm(ctx, llmReply);
  const cookie = await ctx.signIn();
  const invite = await createInvite(ctx, cookie);
  await runInterview(ctx, invite.token);

  const [first, second] = await Promise.all([
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/discovery/public/${invite.token}/complete`,
    }),
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/discovery/public/${invite.token}/complete`,
    }),
  ]);
  assert.equal(first.statusCode, 200, first.payload);
  assert.equal(second.statusCode, 200, second.payload);

  const reports = ctx.db.prepare('select count(*) as total from discovery_report').get() as {
    total: number;
  };
  assert.equal(reports.total, 1);
});

test('the invite total stays stable across pages', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  for (let index = 0; index < 60; index += 1) {
    await createInvite(ctx, cookie, { customerName: `Firma ${index}` });
  }

  const totals: number[] = [];
  const counts: number[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 3; page += 1) {
    const query: string = `limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const response: { statusCode: number; payload: string; json: () => unknown } =
      await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/discovery/invites?${query}`,
        headers: { cookie },
      });
    assert.equal(response.statusCode, 200, response.payload);
    const body = response.json() as {
      items: unknown[];
      total: number;
      nextCursor: string | null;
    };
    totals.push(body.total);
    counts.push(body.items.length);
    cursor = body.nextCursor;
  }
  assert.deepEqual(totals, [60, 60, 60]);
  assert.deepEqual(counts, [25, 25, 10]);
});

test('a report rejects cluster ids outside the catalogue in short mode', async () => {
  const report = {
    summary: 'Kurzer Bericht mit einer erfundenen Cluster-ID.',
    clusters: [{ id: 'Z', title: 'Erfunden', summary: 'Nicht im Katalog.' }],
    opportunities: [
      {
        title: 'Idee',
        benefit: 'Nutzen',
        effort: 'low',
        risk: 'low',
        dataMaturity: 'medium',
        rationale: 'Begründung',
      },
    ],
    quickWins: ['Schnellgewinn'],
    openQuestions: ['Frage?'],
    nextStep: 'Erstgespräch.',
  };
  const call = async () => ({
    status: 200,
    body: JSON.stringify({
      message: { content: JSON.stringify(report) },
      model: { modelKey: 'test-model' },
    }),
  });
  await assert.rejects(
    () =>
      analyse(call, {
        locale: 'de',
        customerName: 'Test GmbH',
        selectedClusters: [],
        answers: [],
      }),
    (error: unknown) => error instanceof AiUnavailable && error.reason === 'invalid_output',
  );
});

test('a 504 from the provider becomes a timeout reason', async () => {
  const call = async () => ({ status: 504, body: '' });
  await assert.rejects(
    () =>
      analyse(call, {
        locale: 'de',
        customerName: 'Test GmbH',
        selectedClusters: ['A'],
        answers: [],
      }),
    (error: unknown) => error instanceof AiUnavailable && error.reason === 'timeout',
  );
});

/** Turns a valid answer into the cut-off shape the provider really returned. */
function cutOff(content: unknown): string {
  const json = JSON.stringify(content);
  return json.slice(0, Math.max(1, Math.floor(json.length * 0.6)));
}

/**
 * A model that answers in the requested JSON but signals `finishReason: 'length'`
 * for the first N calls: exactly the shape the real provider returned when the
 * answer was cut off at 400 tokens.
 */
function truncatingModel(
  cutOffCalls: number,
  content: unknown,
): {
  call: (caller: string, request: { payload?: unknown }) => Promise<LlmReply>;
  budgets: number[];
} {
  const budgets: number[] = [];
  let calls = 0;
  return {
    budgets,
    call: async (_caller, request) => {
      const payload = request.payload as { maxTokens?: number } | undefined;
      budgets.push(payload?.maxTokens ?? 0);
      calls += 1;
      const truncated = calls <= cutOffCalls;
      return {
        status: 200,
        body: JSON.stringify({
          message: { content: truncated ? cutOff(content) : JSON.stringify(content) },
          model: { modelKey: 'test-model' },
          finishReason: truncated ? 'length' : 'stop',
        }),
      };
    },
  };
}

test('a cut-off answer is retried once with a doubled token budget', async () => {
  const model = truncatingModel(1, {
    clusters: [
      { id: 'A', reason: 'Angebote kosten Zeit.' },
      { id: 'B', reason: 'Rechnungen werden doppelt erfasst.' },
    ],
  });
  const warnings: string[] = [];
  const picked = await suggestClusters(model.call, {
    locale: 'de',
    customerName: 'Test GmbH',
    answers: [{ question: 'Was kostet Zeit?', answer: 'Angebote.' }],
    log: { warn: (_obj, message) => warnings.push(message) },
  });

  assert.deepEqual(
    picked.map((entry) => entry.id),
    ['A', 'B'],
  );
  assert.deepEqual(model.budgets, [HINT_MAX_TOKENS, HINT_MAX_TOKENS * 2]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /token budget/);
});

test('an answer cut off twice becomes a defined truncated error, not a schema error', async () => {
  const model = truncatingModel(2, {
    clusters: [
      { id: 'A', reason: 'Angebote kosten Zeit.' },
      { id: 'B', reason: 'Rechnungen werden doppelt erfasst.' },
    ],
  });
  const warnings: string[] = [];
  await assert.rejects(
    () =>
      suggestClusters(model.call, {
        locale: 'de',
        customerName: 'Test GmbH',
        answers: [],
        log: { warn: (_obj, message) => warnings.push(message) },
      }),
    (error: unknown) => error instanceof AiUnavailable && error.reason === 'truncated',
  );
  assert.deepEqual(model.budgets, [HINT_MAX_TOKENS, HINT_MAX_TOKENS * 2]);
  assert.equal(warnings.length, 2);
});

test('a complete answer is accepted unchanged and never retried', async () => {
  const model = truncatingModel(0, {
    hint: 'Ein kurzer Satz genügt.',
    ideas: ['Angebotsentwurf vorbereiten', 'Rechnungen prüfen'],
    examples: ['Zum Beispiel: Angebot per E-Mail.'],
  });
  const result = await interviewHint(model.call, {
    locale: 'de',
    customerName: 'Test GmbH',
    phase: 'deepen',
    question: 'Wie oft?',
    answers: [],
    followUpsUsed: 0,
    showIdeas: true,
  });

  assert.equal(result.hint, 'Ein kurzer Satz genügt.');
  assert.deepEqual(result.ideas, ['Angebotsentwurf vorbereiten', 'Rechnungen prüfen']);
  assert.deepEqual(model.budgets, [HINT_MAX_TOKENS]);
});

test('the analysis retries a cut-off report and keeps the model name', async () => {
  const model = truncatingModel(1, GOOD_REPORT);
  const { report, model: modelKey } = await analyse(model.call, {
    locale: 'de',
    customerName: 'Test GmbH',
    selectedClusters: ['A', 'B'],
    answers: [{ question: 'Angebote?', answer: 'Alles manuell.' }],
  });

  assert.equal(modelKey, 'test-model');
  assert.equal(report.clusters.length, 2);
  assert.deepEqual(model.budgets, [ANALYSIS_MAX_TOKENS, ANALYSIS_MAX_TOKENS * 2]);
});

test('the requests carry the raised budgets and the browser stays inside its timeout', async () => {
  const payloads: Array<{ maxTokens?: number; timeoutMs?: number; purpose?: string }> = [];
  const call = async (_caller: string, request: { payload?: unknown }) => {
    payloads.push(request.payload as { maxTokens?: number; timeoutMs?: number });
    return {
      status: 200,
      body: JSON.stringify({
        message: { content: JSON.stringify(GOOD_REPORT) },
        model: { modelKey: 'test-model' },
        finishReason: 'stop',
      }),
    };
  };

  await analyse(call, {
    locale: 'de',
    customerName: 'Test GmbH',
    selectedClusters: ['A'],
    answers: [],
  });
  assert.equal(payloads[0]?.maxTokens, 4000);
  assert.equal(payloads[0]?.timeoutMs, ANALYSIS_TIMEOUT_MS);
  // The provider repeats a timing-out call once on its own; the browser gives
  // up at 45 s, so two attempts must stay below that.
  assert.ok(2 * ANALYSIS_TIMEOUT_MS < 45_000);
  assert.ok(2 * HINT_TIMEOUT_MS < 45_000);
  assert.ok(ANALYSIS_MAX_TOKENS * 2 <= 8192);
});

/**
 * A model that answers with an empty content string and `finishReason: 'length'`
 * for the first N calls: a reasoning model that spent the whole budget before
 * writing any JSON.
 */
function emptyReasoningModel(
  cutOffCalls: number,
  content: unknown,
): {
  call: (caller: string, request: { payload?: unknown }) => Promise<LlmReply>;
  budgets: number[];
  reasons: string[];
} {
  const budgets: number[] = [];
  const reasons: string[] = [];
  let calls = 0;
  return {
    budgets,
    reasons,
    call: async (_caller, request) => {
      const payload = request.payload as { maxTokens?: number } | undefined;
      budgets.push(payload?.maxTokens ?? 0);
      calls += 1;
      const truncated = calls <= cutOffCalls;
      reasons.push(truncated ? 'length' : 'stop');
      return {
        status: 200,
        body: JSON.stringify({
          message: { content: truncated ? '' : JSON.stringify(content) },
          model: { modelKey: 'test-model' },
          finishReason: truncated ? 'length' : 'stop',
        }),
      };
    },
  };
}

test('an empty answer that hit the budget is retried instead of reported as a schema error', async () => {
  const model = emptyReasoningModel(1, {
    clusters: [
      { id: 'A', reason: 'Angebote kosten Zeit.' },
      { id: 'B', reason: 'Rechnungen werden doppelt erfasst.' },
    ],
  });
  const warnings: string[] = [];
  const picked = await suggestClusters(model.call, {
    locale: 'de',
    customerName: 'Test GmbH',
    answers: [],
    log: { warn: (_obj, message) => warnings.push(message) },
  });

  assert.deepEqual(
    picked.map((entry) => entry.id),
    ['A', 'B'],
  );
  assert.deepEqual(model.budgets, [HINT_MAX_TOKENS, HINT_MAX_TOKENS * 2]);
  assert.equal(warnings.length, 1);
});

test('an empty answer that really stopped stays invalid_output', async () => {
  const budgets: number[] = [];
  const model = {
    budgets,
    call: async (_caller: string, request: { payload?: unknown }) => {
      const payload = request.payload as { maxTokens?: number } | undefined;
      budgets.push(payload?.maxTokens ?? 0);
      return {
        status: 200,
        body: JSON.stringify({
          message: { content: '' },
          model: { modelKey: 'test-model' },
          finishReason: 'stop',
        }),
      };
    },
  };
  await assert.rejects(
    () =>
      suggestClusters(model.call, {
        locale: 'de',
        customerName: 'Test GmbH',
        answers: [],
      }),
    (error: unknown) => error instanceof AiUnavailable && error.reason === 'invalid_output',
  );
  assert.deepEqual(model.budgets, [HINT_MAX_TOKENS]);
});

test('an empty answer cut off twice becomes truncated, not invalid_output', async () => {
  const model = emptyReasoningModel(2, {
    clusters: [
      { id: 'A', reason: 'Angebote kosten Zeit.' },
      { id: 'B', reason: 'Rechnungen werden doppelt erfasst.' },
    ],
  });
  await assert.rejects(
    () =>
      suggestClusters(model.call, {
        locale: 'de',
        customerName: 'Test GmbH',
        answers: [],
      }),
    (error: unknown) => error instanceof AiUnavailable && error.reason === 'truncated',
  );
  assert.deepEqual(model.budgets, [HINT_MAX_TOKENS, HINT_MAX_TOKENS * 2]);
});

test("a provider's max_tokens finish reason counts as cut off", async () => {
  const budgets: number[] = [];
  let calls = 0;
  const call = async (_caller: string, request: { payload?: unknown }) => {
    const payload = request.payload as { maxTokens?: number } | undefined;
    budgets.push(payload?.maxTokens ?? 0);
    calls += 1;
    const truncated = calls === 1;
    return {
      status: 200,
      body: JSON.stringify({
        message: {
          content: truncated
            ? '{"clusters":[{"id":"A"'
            : JSON.stringify({
                clusters: [
                  { id: 'A', reason: 'Angebote kosten Zeit.' },
                  { id: 'B', reason: 'Rechnungen werden doppelt erfasst.' },
                ],
              }),
        },
        model: { modelKey: 'test-model' },
        finishReason: truncated ? 'max_tokens' : 'end_turn',
      }),
    };
  };

  const picked = await suggestClusters(call, {
    locale: 'de',
    customerName: 'Test GmbH',
    answers: [],
  });
  assert.deepEqual(
    picked.map((entry) => entry.id),
    ['A', 'B'],
  );
  assert.deepEqual(budgets, [HINT_MAX_TOKENS, HINT_MAX_TOKENS * 2]);
});

test('a complete JSON answer marked as cut off is accepted without a retry', async () => {
  const budgets: number[] = [];
  const warnings: string[] = [];
  const call = async (_caller: string, request: { payload?: unknown }) => {
    const payload = request.payload as { maxTokens?: number } | undefined;
    budgets.push(payload?.maxTokens ?? 0);
    return {
      status: 200,
      body: JSON.stringify({
        message: {
          content: JSON.stringify({
            clusters: [
              { id: 'A', reason: 'Angebote kosten Zeit.' },
              { id: 'B', reason: 'Rechnungen werden doppelt erfasst.' },
            ],
          }),
        },
        model: { modelKey: 'test-model' },
        finishReason: 'length',
      }),
    };
  };

  const picked = await suggestClusters(call, {
    locale: 'de',
    customerName: 'Test GmbH',
    answers: [],
    log: { warn: (_obj, message) => warnings.push(message) },
  });
  assert.deepEqual(
    picked.map((entry) => entry.id),
    ['A', 'B'],
  );
  assert.deepEqual(budgets, [HINT_MAX_TOKENS]);
  assert.match(warnings[0] ?? '', /cut off but is complete JSON/);
});

test('the whole model call is bounded below the browser timeout', async () => {
  // The browser gives up at 45 s; two attempts, each repeated once by the
  // provider, must still fit, so the server answers first.
  assert.ok(AI_CALL_BUDGET_MS < 45_000);
  assert.ok(AI_CALL_BUDGET_MS <= 40_000);

  let clock = 0;
  const now = () => clock;
  const never = new Promise<string>(() => {});
  await assert.rejects(
    () => withDeadline(never, 40_000, () => new AiUnavailable('timeout', 'late'), now),
    (error: unknown) => error instanceof AiUnavailable && error.reason === 'timeout',
  );

  // An answer before the deadline is passed through unchanged.
  clock = 0;
  const quick = withDeadline(Promise.resolve('ok'), 40_000, () => new Error('late'), now);
  assert.equal(await quick, 'ok');

  // A rejection keeps its own error.
  await assert.rejects(
    () =>
      withDeadline(
        Promise.reject(new AiUnavailable('invalid_output', 'broken')),
        40_000,
        () => new Error('late'),
        now,
      ),
    (error: unknown) => error instanceof AiUnavailable && error.reason === 'invalid_output',
  );
});

test('the retry is skipped when too little of the call budget is left', async (t) => {
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  t.after(() => {
    Date.now = realNow;
  });
  const budgets: number[] = [];
  const warnings: string[] = [];
  const call = async (_caller: string, request: { payload?: unknown }) => {
    const payload = request.payload as { maxTokens?: number } | undefined;
    budgets.push(payload?.maxTokens ?? 0);
    // The first attempt burns almost the whole call budget.
    clock += AI_CALL_BUDGET_MS - 1_000;
    return {
      status: 200,
      body: JSON.stringify({
        message: { content: '{"clusters":[{"id":"A"' },
        model: { modelKey: 'test-model' },
        finishReason: 'length',
      }),
    };
  };

  await assert.rejects(
    () =>
      suggestClusters(call, {
        locale: 'de',
        customerName: 'Test GmbH',
        answers: [],
        log: { warn: (_obj, message) => warnings.push(message) },
      }),
    (error: unknown) => error instanceof AiUnavailable && error.reason === 'truncated',
  );
  assert.deepEqual(budgets, [HINT_MAX_TOKENS]);
  assert.match(warnings[0] ?? '', /retry skipped/);
});

test('the analysis retry stays under the provider token cap', async () => {
  const model = truncatingModel(0, GOOD_REPORT);
  await analyse(model.call, {
    locale: 'de',
    customerName: 'Test GmbH',
    selectedClusters: ['A'],
    answers: [],
  });
  assert.deepEqual(model.budgets, [ANALYSIS_MAX_TOKENS]);
  assert.ok(ANALYSIS_MAX_TOKENS * 2 <= 8192);
});
