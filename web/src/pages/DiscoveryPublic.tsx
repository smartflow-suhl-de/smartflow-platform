import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, discoveryPublic } from '../lib/api';
import { getMessages, type Locale, type Messages } from '../lib/i18n';
import type {
  DiscoveryField,
  DiscoveryPublicState,
  DiscoveryReport,
  DiscoveryStep,
} from '../lib/types';

export interface DiscoveryPublicPageProps {
  token: string;
  locale: Locale;
  messages: Messages;
}

type ClosedKind = 'completed' | 'revoked' | 'expired' | 'invalid';

interface ClosedState {
  kind: ClosedKind;
  report: DiscoveryReport | null;
}

type FieldValue = string | string[] | number | boolean;

/**
 * Turns the controlled field values into the API answer list.
 * Exported because the web test suite checks this mapping without a DOM.
 */
export function answersForStep(
  step: DiscoveryStep,
  values: Record<string, FieldValue>,
): Array<{ key: string; value: unknown }> {
  const answers: Array<{ key: string; value: unknown }> = [];
  for (const field of step.fields) {
    const value = values[field.key];
    if (value === undefined) continue;
    if (typeof value === 'string' && value.trim().length === 0 && !field.required) continue;
    if (Array.isArray(value) && value.length === 0 && !field.required) continue;
    if (field.kind === 'text' && typeof value === 'string') {
      answers.push({ key: field.key, value: value.trim() });
    } else {
      answers.push({ key: field.key, value });
    }
  }
  return answers;
}

export function missingRequired(
  step: DiscoveryStep,
  values: Record<string, FieldValue>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of step.fields) {
    if (!field.required) continue;
    const value = values[field.key];
    if (
      value === undefined ||
      (typeof value === 'string' && value.trim().length === 0) ||
      (Array.isArray(value) && value.length === 0)
    ) {
      errors[field.key] = 'required';
    }
  }
  return errors;
}

function initialValues(
  step: DiscoveryStep,
  answers: Record<string, unknown>,
): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {};
  for (const field of step.fields) {
    const answer = answers[field.key];
    if (field.kind === 'text' && typeof answer === 'string') values[field.key] = answer;
    else if (field.kind === 'number' && typeof answer === 'number') values[field.key] = answer;
    else if (field.kind === 'yesno' && typeof answer === 'boolean') values[field.key] = answer;
    else if (field.kind === 'multi' || field.kind === 'rank') {
      values[field.key] = Array.isArray(answer)
        ? answer.filter((entry): entry is string => typeof entry === 'string')
        : [];
    } else if ((field.kind === 'single' || field.kind === 'scale') && typeof answer === 'string') {
      values[field.key] = answer;
    }
  }
  return values;
}

function localized(text: { de: string; en: string }, locale: Locale): string {
  return locale === 'en' ? text.en : text.de;
}

export function DiscoveryPublicPage({ token, locale, messages }: DiscoveryPublicPageProps) {
  const [state, setState] = useState<DiscoveryPublicState | null>(null);
  const [closed, setClosed] = useState<ClosedState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aiNotice, setAiNotice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [hint, setHint] = useState<{ text: string; examples: string[] } | null>(null);

  const activeLocale = state?.locale ?? locale;
  const m = useMemo(() => getMessages(activeLocale), [activeLocale]);
  const step = state?.step ?? null;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const response = await discoveryPublic.state(token, signal);
        if (response.status === 410) {
          const payload = response.payload as {
            status?: string;
            report?: DiscoveryReport | null;
            error?: { code?: string };
          } | null;
          if (payload?.status === 'completed') {
            setClosed({ kind: 'completed', report: payload.report ?? null });
            return;
          }
          const code = payload?.error?.code;
          setClosed({
            kind: code === 'discovery_link_revoked' ? 'revoked' : 'expired',
            report: null,
          });
          return;
        }
        setState(response.payload as DiscoveryPublicState);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          setClosed({ kind: 'invalid', report: null });
          return;
        }
        setError(err instanceof ApiError ? err.message : messages.discovery.errorBody);
      }
    },
    [token, messages.discovery.errorBody],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (!step) {
      setValues({});
      return;
    }
    setValues(initialValues(step, state?.answers ?? {}));
    setFieldErrors({});
    setSaved(false);
  }, [step?.key, state?.answers]);

  function update(field: DiscoveryField, value: FieldValue): void {
    setValues((current) => ({ ...current, [field.key]: value }));
    setFieldErrors((current) => {
      if (!current[field.key]) return current;
      const next = { ...current };
      delete next[field.key];
      return next;
    });
  }

  function toggleMulti(field: DiscoveryField, option: string): void {
    const current = values[field.key];
    const list = Array.isArray(current) ? current : [];
    const max = field.maxSelections ?? 12;
    if (list.includes(option)) {
      update(
        field,
        list.filter((entry) => entry !== option),
      );
      return;
    }
    if (list.length >= max) return;
    update(field, [...list, option]);
  }

  function moveRank(field: DiscoveryField, index: number, delta: number): void {
    const current = values[field.key];
    const list = Array.isArray(current) ? [...current] : [];
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    const [entry] = list.splice(index, 1);
    if (entry === undefined) return;
    list.splice(target, 0, entry);
    update(field, list);
  }

  async function saveCurrent(): Promise<boolean> {
    if (!step) return true;
    const errors = missingRequired(step, values);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return false;
    }
    const answers = answersForStep(step, values);
    if (answers.length > 0) {
      const response = await discoveryPublic.saveAnswers(token, answers);
      if (response.status === 410) {
        await load();
        return false;
      }
    }
    return true;
  }

  async function handleNext(shortcut = false): Promise<void> {
    if (!step || busy) return;
    setBusy(true);
    setError(null);
    setAiNotice(false);
    setHint(null);
    try {
      const savedOk = await saveCurrent();
      if (!savedOk) return;
      const response = await discoveryPublic.advance(token, shortcut);
      if (response.status === 410) {
        await load();
        return;
      }
      const body = response.payload as {
        state?: DiscoveryPublicState;
        hint?: { text: string; examples: string[] } | null;
      };
      if (body.state) setState(body.state);
      if (body.hint) setHint(body.hint);
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'discovery_ai_unavailable') {
        setAiNotice(true);
      } else if (err instanceof ApiError && err.status === 422) {
        setFieldErrors(err.fields);
      } else {
        setError(err instanceof ApiError ? err.message : m.discovery.errorBody);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveLater(): Promise<void> {
    if (!step || busy) return;
    setBusy(true);
    setError(null);
    try {
      const savedOk = await saveCurrent();
      if (savedOk) setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : m.discovery.errorBody);
    } finally {
      setBusy(false);
    }
  }

  async function handleComplete(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setAiNotice(false);
    try {
      const response = await discoveryPublic.complete(token);
      const payload = response.payload as DiscoveryPublicState | { error?: { code?: string } };
      if (response.status === 410 && 'status' in payload && payload.status === 'completed') {
        setClosed({ kind: 'completed', report: payload.report ?? null });
        return;
      }
      if ('report' in payload) {
        setState(payload);
        setClosed({ kind: 'completed', report: payload.report ?? null });
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'discovery_ai_unavailable') {
        setAiNotice(true);
      } else if (err instanceof ApiError && err.code === 'discovery_analysis_invalid') {
        setError(m.discovery.aiUnavailable);
      } else {
        setError(err instanceof ApiError ? err.message : m.discovery.errorBody);
      }
    } finally {
      setBusy(false);
    }
  }

  if (closed) {
    return (
      <PublicShell m={m} locale={activeLocale}>
        {closed.kind === 'completed' ? (
          <>
            <h1 className="sf-page-title">{m.discovery.completedTitle}</h1>
            <p className="sf-card-text">{m.discovery.completedBody}</p>
            {closed.report ? <ReportView report={closed.report} m={m} /> : null}
          </>
        ) : (
          <>
            <h1 className="sf-page-title">
              {closed.kind === 'revoked'
                ? m.discovery.revokedTitle
                : closed.kind === 'expired'
                  ? m.discovery.expiredTitle
                  : m.discovery.invalidTitle}
            </h1>
            <p className="sf-card-text">
              {closed.kind === 'revoked'
                ? m.discovery.revokedBody
                : closed.kind === 'expired'
                  ? m.discovery.expiredBody
                  : m.discovery.invalidBody}
            </p>
          </>
        )}
        <p className="sf-card-meta">{m.discovery.publicFooter}</p>
      </PublicShell>
    );
  }

  if (!state) {
    return (
      <PublicShell m={m} locale={activeLocale}>
        {error ? (
          <>
            <h1 className="sf-page-title">{m.discovery.errorTitle}</h1>
            <p className="sf-card-text" role="alert">
              {error}
            </p>
            <button type="button" className="sf-btn sf-btn-secondary" onClick={() => void load()}>
              {m.discovery.retry}
            </button>
          </>
        ) : (
          <p role="status">{m.common.loadingPlatform}</p>
        )}
      </PublicShell>
    );
  }

  return (
    <PublicShell m={m} locale={activeLocale}>
      <header className="sf-stack" style={{ gap: 8 }}>
        <p className="sf-brand-eyebrow">{m.discovery.publicBrand}</p>
        <h1 className="sf-page-title">{m.discovery.publicTitle}</h1>
        <p className="sf-card-text">{m.discovery.publicIntro}</p>
        <p className="sf-card-meta">{state.customerName}</p>
      </header>

      <div aria-hidden="true" style={{ height: 8, background: 'var(--line)', borderRadius: 4 }}>
        <div
          style={{
            width: `${Math.max(2, state.progress)}%`,
            height: '100%',
            background: 'var(--cobalt)',
            borderRadius: 4,
          }}
        />
      </div>
      <p className="sf-card-meta" aria-live="polite">
        {m.discovery.progressLabel}: {state.progress}%
      </p>

      {aiNotice ? (
        <div className="sf-alert sf-alert-info" role="status">
          <p>{m.discovery.aiUnavailable}</p>
          <button
            type="button"
            className="sf-btn sf-btn-secondary sf-btn-sm"
            onClick={() => void handleNext()}
          >
            {m.discovery.retry}
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="sf-alert sf-alert-bad" role="alert">
          <p>{error}</p>
        </div>
      ) : null}

      {step ? (
        <form
          className="sf-card"
          onSubmit={(event) => {
            event.preventDefault();
            void handleNext();
          }}
        >
          <div className="sf-card-body sf-stack">
            {step.key === 'consent' ? (
              <div className="sf-stack">
                <h2 className="sf-card-title">{m.discovery.consentTitle}</h2>
                <p className="sf-card-text">{m.discovery.consentNote}</p>
              </div>
            ) : null}

            {hint && hint.text ? (
              <div className="sf-alert sf-alert-info">
                <strong>{m.discovery.hintTitle}</strong>
                <p>{hint.text}</p>
                {hint.examples.length > 0 ? (
                  <>
                    <strong>{m.discovery.examplesTitle}</strong>
                    <ul>
                      {hint.examples.map((example) => (
                        <li key={example}>{example}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </div>
            ) : null}

            {step.fields.map((field, fieldIndex) => (
              <FieldBlock
                key={field.key}
                field={field}
                locale={activeLocale}
                m={m}
                value={values[field.key]}
                error={fieldErrors[field.key]}
                autoFocus={fieldIndex === 0 && step.key !== 'consent'}
                onChange={(value) => update(field, value)}
                onToggleMulti={(option) => toggleMulti(field, option)}
                onMoveRank={(index, delta) => moveRank(field, index, delta)}
                ideas={state.ideas}
              />
            ))}

            <div className="sf-toolbar" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button type="submit" className="sf-btn sf-btn-primary" disabled={busy}>
                {busy ? m.discovery.saving : m.discovery.next}
              </button>
              <button
                type="button"
                className="sf-btn sf-btn-secondary"
                disabled={busy}
                onClick={() => void handleSaveLater()}
              >
                {m.discovery.saveLater}
              </button>
            </div>
            <p className="sf-card-meta">{saved ? m.discovery.saved : m.discovery.saveLaterHint}</p>

            {state.phase === 'map' && step.key === 'map.q12' && state.mode !== 'full' ? (
              <button
                type="button"
                className="sf-btn sf-btn-ghost"
                disabled={busy}
                onClick={() => void handleNext(true)}
              >
                {m.discovery.skipShort}
              </button>
            ) : null}
          </div>
        </form>
      ) : state.canComplete ? (
        <div className="sf-card">
          <div className="sf-card-body sf-stack">
            <h2 className="sf-card-title">{m.discovery.reportTitlePublic}</h2>
            <p className="sf-card-text">{m.discovery.reportIntro}</p>
            <button
              type="button"
              className="sf-btn sf-btn-primary"
              disabled={busy}
              onClick={() => void handleComplete()}
            >
              {busy ? m.discovery.saving : m.discovery.finish}
            </button>
          </div>
        </div>
      ) : (
        <p role="status">{m.common.loadingPlatform}</p>
      )}

      <p className="sf-card-meta">{m.discovery.publicFooter}</p>
    </PublicShell>
  );
}

function PublicShell({
  m,
  locale,
  children,
}: {
  m: Messages;
  locale: Locale;
  children: ReactNode;
}) {
  return (
    <main
      lang={locale === 'en' ? 'en' : 'de'}
      style={{
        maxWidth: 720,
        margin: '0 auto',
        padding: '32px 16px 64px',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      <p className="sf-brand-name">{m.discovery.publicBrand}</p>
      {children}
    </main>
  );
}

function FieldBlock({
  field,
  locale,
  m,
  value,
  error,
  autoFocus,
  onChange,
  onToggleMulti,
  onMoveRank,
  ideas,
}: {
  field: DiscoveryField;
  locale: Locale;
  m: Messages;
  value: FieldValue | undefined;
  error: string | undefined;
  autoFocus: boolean;
  onChange: (value: FieldValue) => void;
  onToggleMulti: (option: string) => void;
  onMoveRank: (index: number, delta: number) => void;
  ideas: Array<{ id: string; title: string }>;
}) {
  const labelId = `discovery-${field.key.replace(/[^a-z0-9]+/gi, '-')}-label`;
  const errorId = `${labelId}-error`;
  const label = localized(field.label, locale);
  const hint = field.help ? localized(field.help, locale) : null;
  const describedBy = error ? errorId : undefined;

  return (
    <div className="sf-field">
      <span className="sf-field-label" id={labelId}>
        {label}
        {field.required ? <span aria-hidden="true"> *</span> : null}
        {!field.required ? <span className="sf-card-meta"> ({m.discovery.optional})</span> : null}
      </span>
      {hint ? <p className="sf-field-hint">{hint}</p> : null}

      {field.kind === 'text' ? (
        <textarea
          className={`sf-input${error ? ' sf-input-invalid' : ''}`}
          rows={field.maxLength && field.maxLength > 600 ? 5 : 3}
          maxLength={field.maxLength ?? 4000}
          value={typeof value === 'string' ? value : ''}
          aria-labelledby={labelId}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          autoFocus={autoFocus}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}

      {field.kind === 'number' ? (
        <input
          className={`sf-input${error ? ' sf-input-invalid' : ''}`}
          type="number"
          inputMode="numeric"
          min={field.min}
          max={field.max}
          value={typeof value === 'number' ? value : ''}
          aria-labelledby={labelId}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          autoFocus={autoFocus}
          onChange={(event) => onChange(Number.parseInt(event.target.value, 10))}
        />
      ) : null}

      {field.kind === 'single' || field.kind === 'scale' ? (
        <select
          className={`sf-input${error ? ' sf-input-invalid' : ''}`}
          value={typeof value === 'string' ? value : ''}
          aria-labelledby={labelId}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          autoFocus={autoFocus}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">—</option>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {localized(option.label, locale)}
            </option>
          ))}
        </select>
      ) : null}

      {field.kind === 'yesno' ? (
        <fieldset
          className="sf-stack"
          style={{ border: 0, padding: 0, margin: 0 }}
          aria-labelledby={labelId}
          aria-describedby={describedBy}
        >
          {[true, false].map((entry) => (
            <label key={String(entry)} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="radio"
                name={field.key}
                checked={value === entry}
                onChange={() => onChange(entry)}
              />
              <span>{entry ? m.discovery.yes : m.discovery.no}</span>
            </label>
          ))}
        </fieldset>
      ) : null}

      {field.kind === 'multi' ? (
        <div
          className="sf-stack"
          role="group"
          aria-labelledby={labelId}
          aria-describedby={describedBy}
        >
          {(field.options ?? []).map((option) => {
            const list = Array.isArray(value) ? value : [];
            const checked = list.includes(option.value);
            const max = field.maxSelections ?? 12;
            const disabled = !checked && list.length >= max;
            return (
              <label
                key={option.value}
                style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onToggleMulti(option.value)}
                />
                <span>{localized(option.label, locale)}</span>
              </label>
            );
          })}
          {field.key.endsWith('.ideas.relevant') && ideas.length > 0 ? (
            <p className="sf-field-hint">{m.discovery.ideasHint}</p>
          ) : null}
        </div>
      ) : null}

      {field.kind === 'rank' ? (
        <div
          className="sf-stack"
          role="group"
          aria-labelledby={labelId}
          aria-describedby={describedBy}
        >
          {(field.options ?? []).length === 0 ? (
            <p className="sf-field-hint">{m.discovery.optional}</p>
          ) : null}
          {(Array.isArray(value) && value.length > 0
            ? value
            : (field.options ?? []).map((option) => option.value)
          ).map((optionValue, index, list) => {
            const option = field.options?.find((entry) => entry.value === optionValue);
            return (
              <div key={optionValue} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ minWidth: 24 }}>{index + 1}.</span>
                <span style={{ flex: 1 }}>
                  {option ? localized(option.label, locale) : optionValue}
                </span>
                <button
                  type="button"
                  className="sf-btn sf-btn-ghost sf-btn-sm"
                  aria-label={`${m.discovery.next}: ${option ? localized(option.label, locale) : optionValue}`}
                  disabled={index === 0}
                  onClick={() => onMoveRank(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="sf-btn sf-btn-ghost sf-btn-sm"
                  aria-label={`${m.discovery.backToStart}: ${option ? localized(option.label, locale) : optionValue}`}
                  disabled={index === list.length - 1}
                  onClick={() => onMoveRank(index, 1)}
                >
                  ↓
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      {error ? (
        <p className="sf-field-error" id={errorId} role="alert">
          {m.discovery.fieldRequired}
        </p>
      ) : null}
    </div>
  );
}

export function ReportView({ report, m }: { report: DiscoveryReport; m: Messages }) {
  return (
    <section className="sf-stack" aria-labelledby="discovery-report-title">
      <h2 className="sf-card-title" id="discovery-report-title">
        {m.discovery.reportTitle}
      </h2>
      <p className="sf-card-text">{report.summary}</p>
      <p className="sf-card-meta">{m.discovery.reportIntro}</p>

      {report.clusters.length > 0 ? (
        <div className="sf-stack">
          <h3 className="sf-card-title">{m.discovery.reportClusters}</h3>
          {report.clusters.map((cluster) => (
            <div key={cluster.id} className="sf-card">
              <div className="sf-card-body">
                <strong>{cluster.title}</strong>
                <p className="sf-card-text">{cluster.summary}</p>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="sf-stack">
        <h3 className="sf-card-title">{m.discovery.reportOpportunities}</h3>
        {report.opportunities.map((opportunity) => (
          <div key={opportunity.title} className="sf-card">
            <div className="sf-card-body sf-stack">
              <strong>{opportunity.title}</strong>
              <p className="sf-card-text">{opportunity.benefit}</p>
              <p className="sf-card-text">{opportunity.rationale}</p>
              <dl className="sf-kv-list">
                <div className="sf-kv-row">
                  <dt>{m.discovery.effort}</dt>
                  <dd>{opportunity.effort}</dd>
                </div>
                <div className="sf-kv-row">
                  <dt>{m.discovery.risk}</dt>
                  <dd>{opportunity.risk}</dd>
                </div>
                <div className="sf-kv-row">
                  <dt>{m.discovery.dataMaturity}</dt>
                  <dd>{opportunity.dataMaturity}</dd>
                </div>
              </dl>
            </div>
          </div>
        ))}
      </div>

      {report.quickWins.length > 0 ? (
        <div className="sf-stack">
          <h3 className="sf-card-title">{m.discovery.reportQuickWins}</h3>
          <ul>
            {report.quickWins.map((win) => (
              <li key={win}>{win}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {report.openQuestions.length > 0 ? (
        <div className="sf-stack">
          <h3 className="sf-card-title">{m.discovery.reportOpenQuestions}</h3>
          <ul>
            {report.openQuestions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="sf-alert sf-alert-info">
        <strong>{m.discovery.reportNextStep}</strong>
        <p>{report.nextStep}</p>
      </div>
    </section>
  );
}
