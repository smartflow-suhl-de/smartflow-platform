import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIcon, BuildingIcon, CompassIcon } from '../components/icons';
import { Badge, Button, PageHeader } from '../components/ui';
import { api, isAbortError } from '../lib/api';
import { formatApiError, type Locale, type Messages } from '../lib/i18n';
import { AppLink } from '../lib/router';
import type { AgentRun, AgentSourceInfo, AgentStatus } from '../lib/types';

export interface AgentPageProps {
  locale: Locale;
  messages: Messages;
}

interface Entry {
  run: AgentRun;
  sources: AgentSourceInfo[];
  truncated: boolean;
}

/** Clock time for a run; the date is in the query log, not in the bubble. */
function clock(iso: string, locale: Locale): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(locale === 'de' ? 'de-DE' : 'en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/**
 * Plain text from the model, rendered without HTML.
 *
 * Paragraphs stay paragraphs, consecutive `-`/`*` lines become a list. The
 * model output is untrusted data and never reaches `dangerouslySetInnerHTML`.
 */
export function AnswerBody({ text }: { text: string }) {
  const nodes = useMemo(() => {
    const out: ReactNode[] = [];
    let list: string[] = [];
    let paragraph: string[] = [];

    const flushList = () => {
      if (list.length === 0) return;
      out.push(
        <ul key={`list-${out.length}`}>
          {list.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>,
      );
      list = [];
    };

    const flushParagraph = () => {
      if (paragraph.length === 0) return;
      out.push(<p key={`p-${out.length}`}>{paragraph.join(' ')}</p>);
      paragraph = [];
    };

    for (const line of text.split(/\r?\n/)) {
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      if (bullet) {
        flushParagraph();
        list.push(bullet[1] ?? '');
        continue;
      }
      if (line.trim().length === 0) {
        flushList();
        flushParagraph();
        continue;
      }
      flushList();
      paragraph.push(line.trim());
    }
    flushList();
    flushParagraph();
    return out;
  }, [text]);

  return <>{nodes}</>;
}

export function AgentPage({ locale, messages }: AgentPageProps) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [statusVersion, setStatusVersion] = useState(0);
  const [question, setQuestion] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastAttempt, setLastAttempt] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const lastAnswerRef = useRef<HTMLElement | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .agentStatus(controller.signal)
      .then((next) => setStatus(next))
      .catch((failure: unknown) => {
        if (isAbortError(failure)) return;
        setStatusFailed(true);
      });
    return () => controller.abort();
  }, [statusVersion]);

  const reloadStatus = useCallback(() => {
    setStatusFailed(false);
    setStatusVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    if (entries.length > 0) lastAnswerRef.current?.focus();
  }, [entries.length]);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );

  const ask = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (text.length === 0 || asking) return;
      setAsking(true);
      setError(null);
      setLastAttempt(text);
      try {
        const response = await api.agentAsk(text);
        setEntries((previous) => [
          ...previous,
          { run: response.run, sources: response.sources, truncated: response.truncated },
        ]);
        setQuestion('');
      } catch (failure: unknown) {
        if (isAbortError(failure)) return;
        setError(formatApiError(failure, locale));
      } finally {
        setAsking(false);
      }
    },
    [asking, locale],
  );

  const copy = useCallback((entry: Entry) => {
    const answer = entry.run.answer ?? '';
    if (answer.length === 0 || typeof navigator === 'undefined' || !navigator.clipboard) return;
    navigator.clipboard
      .writeText(answer)
      .then(() => {
        setCopiedId(entry.run.id);
        if (copyTimer.current !== null) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopiedId(null), 2_000);
      })
      .catch(() => undefined);
  }, []);

  const configured = status?.configured === true;
  const disabled = !configured || asking;
  const examples = [
    {
      icon: <BuildingIcon size={15} />,
      label: 'TENANTS',
      title: messages.agent.exampleTenantsTitle,
      text: messages.agent.exampleTenantsText,
    },
    {
      icon: <ActivityIcon size={15} />,
      label: 'EVENTS',
      title: messages.agent.exampleEventsTitle,
      text: messages.agent.exampleEventsText,
    },
    {
      icon: <CompassIcon size={15} />,
      label: 'AGENT',
      title: messages.agent.exampleSourcesTitle,
      text: messages.agent.exampleSourcesText,
    },
  ];

  return (
    <div className="sf-agent">
      <PageHeader
        title={messages.agent.title}
        description={messages.agent.description}
        actions={
          <>
            {status ? (
              <Badge tone={configured ? 'good' : 'warn'}>
                {configured ? messages.agent.ready : messages.agent.notConfigured}
              </Badge>
            ) : null}
            {status?.model ? <span className="sf-agent-model numeric">{status.model}</span> : null}
            {entries.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={asking}
                onClick={() => {
                  setEntries([]);
                  setError(null);
                }}
              >
                {messages.agent.newQuestion}
              </Button>
            ) : null}
          </>
        }
      />

      {statusFailed ? (
        <div className="sf-alert sf-alert-bad" role="alert">
          <span>{messages.common.platformUnavailable}</span>
          <Button variant="secondary" size="sm" onClick={reloadStatus}>
            {messages.agent.checkStatus}
          </Button>
        </div>
      ) : null}

      {status && !status.configured ? (
        <div className="sf-agent-notice">
          <div className="sf-agent-notice-head">
            <span className="sf-dot sf-dot-warn" aria-hidden="true" />
            <h2 className="sf-agent-notice-title">
              {status.reachable
                ? messages.agent.providerMissingTitle
                : messages.agent.providerUnreachableTitle}
            </h2>
          </div>
          <p className="sf-agent-notice-text">
            {status.reachable
              ? messages.agent.providerMissingText
              : messages.agent.providerUnreachableText}
          </p>
          <Button variant="secondary" size="sm" onClick={reloadStatus}>
            {messages.agent.checkStatus}
          </Button>
        </div>
      ) : null}

      {entries.length === 0 ? (
        <div className="sf-agent-empty">
          <div className="sf-agent-column">
            <div className="sf-agent-composer">
              <label className="sr-only" htmlFor="sf-agent-question">
                {messages.agent.textareaLabel}
              </label>
              <textarea
                id="sf-agent-question"
                className="sf-agent-input"
                rows={3}
                value={question}
                placeholder={
                  configured || status === null
                    ? messages.agent.placeholder
                    : messages.agent.notConfigured
                }
                disabled={disabled}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void ask(question);
                  }
                }}
              />
              <div className="sf-agent-bar">
                <span className="sf-agent-hint">
                  {asking ? messages.agent.thinking : messages.agent.hint}
                </span>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={disabled || question.trim().length === 0}
                  onClick={() => void ask(question)}
                >
                  {asking ? messages.agent.thinking : messages.agent.send}
                </Button>
              </div>
            </div>

            <div className="sf-agent-examples">
              <div className="sf-agent-examples-head">
                <span className="label">{messages.agent.examples}</span>
                <span className="sf-agent-examples-hint">{messages.agent.examplesHint}</span>
              </div>
              <div className="sf-agent-example-grid">
                {examples.map((example) => (
                  <button
                    key={example.title}
                    type="button"
                    className="sf-agent-example"
                    disabled={disabled}
                    onClick={() => void ask(example.title)}
                  >
                    <span className="sf-agent-example-top">
                      {example.icon}
                      <span className="label">{example.label}</span>
                    </span>
                    <span className="sf-agent-example-title">{example.title}</span>
                    <span className="sf-agent-example-text">{example.text}</span>
                  </button>
                ))}
              </div>
            </div>

            {status ? (
              <p className="sf-agent-meta">
                <span>{messages.agent.retention(status.retentionDays)}</span>
                <span aria-hidden="true"> / </span>
                <span>{messages.agent.limit(status.limits.perMinute, status.limits.perDay)}</span>
              </p>
            ) : null}

            {error ? (
              <div className="sf-alert sf-alert-bad sf-agent-error" role="alert">
                <span>
                  {messages.agent.errorTitle} {error}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={asking || lastAttempt.length === 0}
                  onClick={() => void ask(lastAttempt)}
                >
                  {messages.common.retry}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="sf-agent-thread sf-agent-column">
          {entries.map((entry, index) => {
            const isLast = index === entries.length - 1;
            const totalMs = entry.run.steps.reduce((sum, step) => sum + step.durationMs, 0);
            return (
              <div key={entry.run.id} className="sf-agent-exchange">
                <div className="sf-agent-question">
                  <span className="sf-agent-clock numeric">
                    {clock(entry.run.createdAt, locale)}
                  </span>
                  <p>{entry.run.question}</p>
                </div>

                <article
                  className="sf-agent-answer"
                  ref={isLast ? lastAnswerRef : undefined}
                  tabIndex={isLast ? -1 : undefined}
                  aria-live={isLast ? 'polite' : undefined}
                >
                  <div className="sf-agent-answer-head">
                    <span className="label">Agent</span>
                    <span className="sf-agent-answer-meta numeric">
                      {messages.agent.stepsSummary(entry.run.steps.length, totalMs)}
                    </span>
                  </div>

                  <div className="sf-agent-answer-body">
                    {entry.run.answer ? (
                      <AnswerBody text={entry.run.answer} />
                    ) : (
                      <p>{messages.agent.emptyAnswer}</p>
                    )}
                    {entry.truncated ? (
                      <p className="sf-agent-truncated">{messages.agent.truncatedNotice}</p>
                    ) : null}
                  </div>

                  {entry.sources.length > 0 ? (
                    <div className="sf-agent-sources">
                      <div className="label">{messages.agent.sources}</div>
                      <div className="sf-agent-chips">
                        {entry.sources.map((source) => {
                          const content = (
                            <>
                              <span className="sf-agent-chip-dot" aria-hidden="true" />
                              {source.label}
                            </>
                          );
                          return source.href ? (
                            <AppLink
                              key={source.id}
                              to={source.href}
                              className="sf-agent-chip"
                              title={source.description}
                            >
                              {content}
                            </AppLink>
                          ) : (
                            <span
                              key={source.id}
                              className="sf-agent-chip"
                              title={source.description}
                            >
                              {content}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  {entry.run.steps.length > 0 ? (
                    <details className="sf-agent-steps">
                      <summary>
                        {messages.agent.steps}
                        <span className="sf-agent-steps-count numeric">
                          {entry.run.steps.length}
                        </span>
                      </summary>
                      <div className="sf-agent-step-rows">
                        {entry.run.steps.map((step) => (
                          <div key={`${entry.run.id}-${step.seq}`} className="sf-agent-step">
                            <span className="sf-agent-step-source">
                              {step.source}
                              {step.truncated ? ' *' : ''}
                            </span>
                            <span
                              className={
                                step.status === 'ok' ? 'sf-agent-step-ok' : 'sf-agent-step-error'
                              }
                            >
                              {step.status === 'ok'
                                ? messages.agent.stepOk
                                : messages.agent.stepError}
                            </span>
                            <span className="numeric">{step.durationMs} ms</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  ) : null}

                  <div className="sf-agent-answer-foot">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!entry.run.answer}
                      onClick={() => copy(entry)}
                    >
                      {copiedId === entry.run.id ? messages.agent.copied : messages.agent.copy}
                    </Button>
                    <span className="sf-agent-stand numeric">
                      {messages.agent.stand(clock(entry.run.createdAt, locale))}
                    </span>
                  </div>
                </article>
              </div>
            );
          })}

          {error ? (
            <div className="sf-alert sf-alert-bad sf-agent-error" role="alert">
              <span>
                {messages.agent.errorTitle} {error}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={asking}
                onClick={() => void ask(lastAttempt)}
              >
                {messages.common.retry}
              </Button>
            </div>
          ) : null}

          <div className="sf-agent-composer sf-agent-dock">
            <label className="sr-only" htmlFor="sf-agent-followup">
              {messages.agent.textareaLabel}
            </label>
            <textarea
              id="sf-agent-followup"
              className="sf-agent-input sf-agent-input-compact"
              rows={1}
              value={question}
              placeholder={messages.agent.placeholder}
              disabled={disabled}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void ask(question);
                }
              }}
            />
            <div className="sf-agent-bar">
              <span className="sf-agent-hint">
                {asking ? messages.agent.thinking : messages.agent.hint}
              </span>
              <Button
                variant="primary"
                size="sm"
                disabled={disabled || question.trim().length === 0}
                onClick={() => void ask(question)}
              >
                {asking ? messages.agent.thinking : messages.agent.send}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
