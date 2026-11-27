import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createTestApp, type TestApp } from './helpers.ts';
import {
  PublicRateLimiter,
  publicRateLimiter,
} from '../../src/plugins/automation-discovery/server.ts';
import { analyse, AiUnavailable } from '../../src/plugins/automation-discovery/ai.ts';

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

test('a tenant invite takes the tenant name and needs no customer data or email', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.close());
  const cookie = await ctx.signIn();
  const tenantResponse = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/tenants',
    headers: { cookie },
    payload: { name: 'Nordwind Logistik GmbH' },
  });
  const tenant = tenantResponse.json() as { id: string; name: string };

  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/discovery/invites',
    headers: { cookie },
    payload: { tenantId: tenant.id, locale: 'de' },
  });
  assert.equal(response.statusCode, 201, response.payload);
  const invite = (response.json() as {
    invite: { customerName: string; contactEmail: string | null; tenantId: string };
  }).invite;
  assert.equal(invite.customerName, tenant.name);
  assert.equal(invite.contactEmail, null);
  assert.equal(invite.tenantId, tenant.id);

  // A contact address sent with a tenant invite is ignored, not stored.
  const withEmail = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/discovery/invites',
    headers: { cookie },
    payload: { tenantId: tenant.id, contactEmail: 'kunde@firma.de' },
  });
  assert.equal(withEmail.statusCode, 201, withEmail.payload);
  assert.equal(
    (withEmail.json() as { invite: { contactEmail: string | null } }).invite.contactEmail,
    null,
  );

  // Without a tenant and without a name the request stays invalid.
  const missing = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/discovery/invites',
    headers: { cookie },
    payload: { locale: 'de' },
  });
  assert.equal(missing.statusCode, 422);
  assert.equal(
    (missing.json() as { error?: { fields?: { customerName?: string } } }).error?.fields
      ?.customerName !== undefined,
    true,
  );
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
