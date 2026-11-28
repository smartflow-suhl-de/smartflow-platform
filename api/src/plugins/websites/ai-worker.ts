import { newId } from '../../kernel/ids.ts';
import { MAX_PAGES_PER_JOB } from './runtime.ts';
import { MAX_ROUTE, ROUTE_PATTERN, type JobRow, type SiteRow } from './store.ts';
import type { Runtime } from './runtime.ts';

/** Enough for a plan with a dozen pages; the tenant limit caps it further. */
const MAX_PLAN_TOKENS = 8_000;

export interface AiWorker {
  run(tenantId: string, job: JobRow): Promise<void>;
}

interface PlanPage {
  route?: unknown;
  title?: unknown;
  body?: unknown;
}

interface Plan {
  summary?: unknown;
  pages?: unknown;
}

const SYSTEM_PROMPT = `Du planst die Seiten einer kleinen Website und schreibst den Text dafür.
Antworte ausschließlich mit JSON in dieser Form:
{"summary": "ein Satz zur Seite", "pages": [{"route": "/", "title": "Startseite", "body": "Markdown"}]}
Regeln:
- route beginnt mit "/", nur Kleinbuchstaben, Ziffern und einzelne Bindestriche, keine Query.
- Genau eine Seite mit route "/".
- body ist Markdown ohne Überschrift der Ebene 1, 2 bis 6 Absätze, sachlich, keine erfundenen Fakten.
- Keine Preise, keine Öffnungszeiten und keine Adressen erfinden.`;

/**
 * AI jobs are consumed by the API process, like builds: the LLM plugin is the
 * only place that talks to a provider, and this worker only shapes the answer.
 */
export function createAiWorker(runtime: Runtime): AiWorker {
  const { log } = runtime;

  function fail(database: ReturnType<Runtime['tenantDb']>, job: JobRow, message: string): void {
    database
      .prepare(`update web_ai_jobs set status = 'failed', error = ?, updated_at = ? where id = ?`)
      .run(message.slice(0, 500), runtime.now().toISOString(), job.id);
    // No refresh hook and no build here: a failed job wrote no pages, so there
    // is nothing new to deliver and nothing to rebuild.
  }

  async function complete(job: JobRow, site: SiteRow, brief: Record<string, unknown>) {
    const goal = typeof brief.goal === 'string' ? brief.goal : '';
    const tone = typeof brief.tone === 'string' ? brief.tone : '';
    const pages = Array.isArray(brief.pages)
      ? brief.pages.filter((p) => typeof p === 'string')
      : [];
    const sources = typeof brief.sources === 'string' ? brief.sources : '';
    const user = [
      `Website: ${site.name}`,
      `Ziel: ${goal}`,
      tone ? `Tonalität: ${tone}` : '',
      pages.length > 0 ? `Gewünschte Routen: ${pages.join(', ')}` : '',
      sources ? `Quellen: ${sources}` : '',
      `Höchstens ${MAX_PAGES_PER_JOB} Seiten.`,
    ]
      .filter((line) => line.length > 0)
      .join('\n');

    return runtime.ctx.callInternal(runtime.ctx.manifest.id, {
      method: 'POST',
      url: '/api/v1/llm/internal/complete',
      payload: {
        purpose: 'website-plan',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
        responseFormat: { type: 'json_object' },
        maxTokens: Math.min(Number(brief.max_tokens) || 4_000, MAX_PLAN_TOKENS),
        metadata: { tenantId: job.site_id, requestId: job.id },
      },
    });
  }

  /** Models wrap JSON in fences often enough that stripping them is not optional. */
  function parsePlan(content: string): Plan {
    const trimmed = content
      .trim()
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/, '')
      .trim();
    return JSON.parse(trimmed) as Plan;
  }

  return {
    async run(tenantId, job) {
      const database = runtime.tenantDb(tenantId);
      const site = database.prepare('select * from web_sites where id = ?').get(job.site_id) as
        SiteRow | undefined;
      if (!site) {
        fail(database, job, 'Website nicht gefunden.');
        return;
      }
      const claimed = database
        .prepare(
          `update web_ai_jobs set status = 'running', updated_at = ?
            where id = ? and status = 'queued'`,
        )
        .run(runtime.now().toISOString(), job.id);
      if (claimed.changes !== 1) return;

      const response = await complete(
        job,
        site,
        JSON.parse(job.brief_json) as Record<string, unknown>,
      );
      if (response.status !== 200) {
        let message = `Der KI-Dienst antwortete mit ${response.status}.`;
        try {
          const body = JSON.parse(response.body) as { error?: { message?: string } };
          if (body.error?.message) message = body.error.message;
        } catch {
          // Keep the status-based message.
        }
        fail(database, job, message);
        return;
      }

      let payload: {
        message?: { content?: string };
        usage?: { inputTokens?: number | null; outputTokens?: number | null };
        costMicros?: number | null;
        model?: { modelKey?: string };
      };
      try {
        payload = JSON.parse(response.body) as typeof payload;
      } catch {
        fail(database, job, 'Der KI-Dienst lieferte keine lesbare Antwort.');
        return;
      }

      let plan: Plan;
      try {
        plan = parsePlan(payload.message?.content ?? '');
      } catch {
        fail(database, job, 'Die Antwort war kein gültiges JSON.');
        return;
      }

      const summary = typeof plan.summary === 'string' ? plan.summary.slice(0, 1_000) : '';
      const entries = (Array.isArray(plan.pages) ? plan.pages : [])
        .slice(0, MAX_PAGES_PER_JOB)
        .map((raw) => raw as PlanPage)
        .filter(
          (page) =>
            typeof page.route === 'string' &&
            ROUTE_PATTERN.test(page.route) &&
            page.route.length <= MAX_ROUTE &&
            typeof page.title === 'string' &&
            page.title.trim().length > 0,
        )
        .map((page) => ({
          route: page.route as string,
          title: (page.title as string).trim().slice(0, 120),
          body: typeof page.body === 'string' ? page.body.trim() : '',
        }));

      if (entries.length === 0) {
        fail(database, job, 'Der Plan enthielt keine gültige Seite.');
        return;
      }

      const timestamp = runtime.now().toISOString();
      const costCents = Math.round((payload.costMicros ?? 0) / 10_000);
      database
        .prepare(
          `update web_ai_jobs
              set status = 'ok', plan_json = ?, tokens_in = ?, tokens_out = ?, cost_cents = ?,
                  error = null, updated_at = ?
            where id = ?`,
        )
        .run(
          JSON.stringify({
            summary,
            pages: entries.map(({ route, title }) => ({ route, title })),
          }),
          payload.usage?.inputTokens ?? 0,
          payload.usage?.outputTokens ?? 0,
          costCents,
          timestamp,
          job.id,
        );

      for (const page of entries) {
        database
          .prepare(
            `insert into web_site_pages
               (id, site_id, route, title, origin, body_md, created_at, updated_at)
             values (?, ?, ?, ?, 'ai', ?, ?, ?)
             on conflict(site_id, route) do update
               set title = excluded.title, origin = 'ai', body_md = excluded.body_md,
                   updated_at = excluded.updated_at`,
          )
          .run(
            newId('page'),
            job.site_id,
            page.route,
            page.title,
            page.body.length > 0 ? page.body.slice(0, 40_000) : null,
            timestamp,
            timestamp,
          );
      }
      database
        .prepare('update web_sites set updated_at = ? where id = ?')
        .run(timestamp, job.site_id);
      log.info(
        { jobId: job.id, siteId: job.site_id, pages: entries.length },
        'website plan written',
      );
      runtime.onJobSettled?.(tenantId, job.site_id);
    },
  };
}
