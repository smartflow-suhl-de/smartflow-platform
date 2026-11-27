import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { HelpTip } from '../components/HelpTip';
import { ActivityIcon, BuildingIcon, CompassIcon } from '../components/icons';
import { Badge, Button, Card, CardHeader, ConfirmModal, Input, PageHeader } from '../components/ui';
import { useToast } from '../components/useToast';
import { api, isAbortError } from '../lib/api';
import { formatApiError, formatDateTime, type Locale, type Messages } from '../lib/i18n';
import { AppLink, navigate } from '../lib/router';
import type {
  AgentRun,
  AgentSourceInfo,
  AgentStatus,
  LlmModel,
  LlmProvider,
} from '../lib/types';

export interface AgentPageProps {
  locale: Locale;
  messages: Messages;
}

interface Entry {
  run: AgentRun;
  sources: AgentSourceInfo[];
  truncated: boolean;
}

/**
 * Sources of a stored run: only the ids of its source calls were persisted, so
 * the readable label and link come from the live source list.
 */
function sourcesForRun(run: AgentRun, byId: Map<string, AgentSourceInfo>): AgentSourceInfo[] {
  const seen = new Set<string>();
  const out: AgentSourceInfo[] = [];
  for (const step of run.steps) {
    if (seen.has(step.source)) continue;
    seen.add(step.source);
    out.push(byId.get(step.source) ?? { id: step.source, label: step.source, description: '' });
  }
  return out;
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
 * Renders safe inline Markdown (`**bold**`, `*italic*`, `` `code` ``) as React
 * nodes without `dangerouslySetInnerHTML`.
 */
function renderInlineMarkdown(text: string): ReactNode[] {
  const tokens: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push(text.slice(lastIndex, match.index));
    }
    const raw = match[0];
    if (raw.startsWith('`') && raw.endsWith('`')) {
      tokens.push(<code key={key++}>{raw.slice(1, -1)}</code>);
    } else if (
      (raw.startsWith('**') && raw.endsWith('**')) ||
      (raw.startsWith('__') && raw.endsWith('__'))
    ) {
      tokens.push(<strong key={key++}>{raw.slice(2, -2)}</strong>);
    } else if (raw.startsWith('*') && raw.endsWith('*')) {
      tokens.push(<em key={key++}>{raw.slice(1, -1)}</em>);
    } else {
      tokens.push(raw);
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) {
    tokens.push(text.slice(lastIndex));
  }
  return tokens;
}

/**
 * Markdown from the model, rendered as React nodes without HTML injection.
 *
 * Supports headings, paragraphs, unordered/ordered lists, fenced code blocks,
 * and inline bold/italic/code. The model output is untrusted data and never
 * reaches `dangerouslySetInnerHTML`.
 */
export function AnswerBody({ text }: { text: string }) {
  const nodes = useMemo(() => {
    const out: ReactNode[] = [];
    let ul: string[] = [];
    let ol: string[] = [];
    let paragraph: string[] = [];
    let codeBlock: string[] | null = null;

    const flushUl = () => {
      if (ul.length === 0) return;
      out.push(
        <ul key={`ul-${out.length}`}>
          {ul.map((item, index) => (
            <li key={index}>{renderInlineMarkdown(item)}</li>
          ))}
        </ul>,
      );
      ul = [];
    };

    const flushOl = () => {
      if (ol.length === 0) return;
      out.push(
        <ol key={`ol-${out.length}`}>
          {ol.map((item, index) => (
            <li key={index}>{renderInlineMarkdown(item)}</li>
          ))}
        </ol>,
      );
      ol = [];
    };

    const flushParagraph = () => {
      if (paragraph.length === 0) return;
      out.push(<p key={`p-${out.length}`}>{renderInlineMarkdown(paragraph.join(' '))}</p>);
      paragraph = [];
    };

    const flushAll = () => {
      flushUl();
      flushOl();
      flushParagraph();
    };

    for (const line of text.split(/\r?\n/)) {
      if (line.trimStart().startsWith('```')) {
        if (codeBlock !== null) {
          out.push(
            <pre key={`pre-${out.length}`}>
              <code>{codeBlock.join('\n')}</code>
            </pre>,
          );
          codeBlock = null;
        } else {
          flushAll();
          codeBlock = [];
        }
        continue;
      }
      if (codeBlock !== null) {
        codeBlock.push(line);
        continue;
      }

      const heading = /^\s*(#{1,4})\s+(.*)$/.exec(line);
      if (heading) {
        flushAll();
        const level = heading[1]?.length ?? 3;
        const content = renderInlineMarkdown(heading[2] ?? '');
        if (level === 1) out.push(<h3 key={`h-${out.length}`}>{content}</h3>);
        else if (level === 2) out.push(<h4 key={`h-${out.length}`}>{content}</h4>);
        else out.push(<h5 key={`h-${out.length}`}>{content}</h5>);
        continue;
      }

      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      if (bullet) {
        flushParagraph();
        flushOl();
        ul.push(bullet[1] ?? '');
        continue;
      }

      const ordered = /^\s*\d+\.\s+(.*)$/.exec(line);
      if (ordered) {
        flushParagraph();
        flushUl();
        ol.push(ordered[1] ?? '');
        continue;
      }

      if (line.trim().length === 0) {
        flushAll();
        continue;
      }

      flushUl();
      flushOl();
      paragraph.push(line.trim());
    }

    if (codeBlock !== null) {
      out.push(
        <pre key={`pre-${out.length}`}>
          <code>{codeBlock.join('\n')}</code>
        </pre>,
      );
    }
    flushAll();
    return out;
  }, [text]);

  return <>{nodes}</>;
}

export function AgentPage({ locale, messages }: AgentPageProps) {
  const showToast = useToast();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [statusVersion, setStatusVersion] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [models, setModels] = useState<LlmModel[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState('');
  const [selectedModelId, setSelectedModelId] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);
  const [question, setQuestion] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [asking, setAsking] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyItems, setHistoryItems] = useState<AgentRun[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AgentRun | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const lastAnswerRef = useRef<HTMLElement | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const askController = useRef<AbortController | null>(null);
  const historyController = useRef<AbortController | null>(null);

  /** Stored runs carry source ids only; labels come from the live source list. */
  const sourceMap = useMemo(
    () => new Map((status?.sources ?? []).map((source) => [source.id, source])),
    [status],
  );

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
    if (!settingsOpen) return;
    const controller = new AbortController();
    Promise.all([
      api.agentSettings(controller.signal),
      api.listLlmProviders({ status: 'active', limit: 50 }, controller.signal),
    ])
      .then(([saved, page]) => {
        const allowed = page.items.filter(
          (p) => p.allowedPlugins === null || p.allowedPlugins.includes('agent'),
        );
        setProviders(allowed);
        setSelectedProviderId(saved.providerId ?? '');
        setSelectedModelId(saved.modelId ?? '');
      })
      .catch((failure: unknown) => {
        if (isAbortError(failure)) return;
        showToast(formatApiError(failure, locale), { tone: 'bad' });
      });
    return () => controller.abort();
  }, [settingsOpen, locale, showToast]);

  useEffect(() => {
    if (!settingsOpen || !selectedProviderId) {
      setModels([]);
      return;
    }
    const controller = new AbortController();
    api
      .listLlmModels(selectedProviderId, controller.signal)
      .then((list) => setModels(list.filter((m) => m.status === 'active')))
      .catch((failure: unknown) => {
        if (isAbortError(failure)) return;
        setModels([]);
      });
    return () => controller.abort();
  }, [settingsOpen, selectedProviderId]);

  const saveSettings = useCallback(async () => {
    setSavingSettings(true);
    try {
      await api.updateAgentSettings({
        providerId: selectedProviderId || null,
        modelId: selectedProviderId && selectedModelId ? selectedModelId : null,
      });
      showToast(messages.llm.saved);
      setSettingsOpen(false);
      reloadStatus();
    } catch (failure: unknown) {
      showToast(formatApiError(failure, locale), { tone: 'bad' });
    } finally {
      setSavingSettings(false);
    }
  }, [selectedProviderId, selectedModelId, messages.llm.saved, locale, showToast, reloadStatus]);

  /** Loads one page of the stored history, filtered by the search text. */
  const loadHistory = useCallback(
    async (options: { append?: boolean; q?: string } = {}) => {
      const append = options.append === true;
      historyController.current?.abort();
      const controller = new AbortController();
      historyController.current = controller;
      setHistoryLoading(true);
      try {
        const page = await api.agentRuns(
          {
            limit: 20,
            cursor: append ? historyCursor : null,
            ...(options.q ? { q: options.q } : {}),
          },
          controller.signal,
        );
        setHistoryItems((previous) => (append ? [...previous, ...page.items] : page.items));
        setHistoryTotal(page.total);
        setHistoryCursor(page.nextCursor);
        setHistoryLoaded(true);
      } catch (failure: unknown) {
        if (isAbortError(failure)) return;
        showToast(formatApiError(failure, locale), { tone: 'bad' });
      } finally {
        if (!controller.signal.aborted) setHistoryLoading(false);
      }
    },
    [historyCursor, locale, showToast],
  );

  useEffect(() => {
    if (!historyOpen) return;
    void loadHistory({ q: historyQuery.trim() || undefined });
    // Only the search text and the open state reload page one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyOpen, historyQuery]);

  const openRun = useCallback(
    (run: AgentRun) => {
      setEntries([{ run, sources: sourcesForRun(run, sourceMap), truncated: false }]);
      setHistoryOpen(false);
      showToast(messages.agent.historyRestored);
    },
    [messages.agent.historyRestored, showToast, sourceMap],
  );

  const deleteRun = useCallback(async () => {
    if (!deleteTarget) return;
    setHistoryBusy(true);
    try {
      await api.deleteAgentRun(deleteTarget.id);
      setHistoryItems((previous) => previous.filter((item) => item.id !== deleteTarget.id));
      setHistoryTotal((total) => Math.max(0, total - 1));
      setEntries((previous) => previous.filter((entry) => entry.run.id !== deleteTarget.id));
      showToast(messages.agent.historyDeleted);
      setDeleteTarget(null);
    } catch (failure: unknown) {
      showToast(formatApiError(failure, locale), { tone: 'bad' });
    } finally {
      setHistoryBusy(false);
    }
  }, [deleteTarget, locale, messages.agent.historyDeleted, showToast]);

  const clearAll = useCallback(async () => {
    setHistoryBusy(true);
    try {
      const deleted = await api.deleteAgentRuns();
      setHistoryItems([]);
      setHistoryTotal(0);
      setHistoryCursor(null);
      setEntries([]);
      askController.current?.abort();
      showToast(messages.agent.historyCleared(deleted));
      setClearOpen(false);
    } catch (failure: unknown) {
      showToast(formatApiError(failure, locale), { tone: 'bad' });
    } finally {
      setHistoryBusy(false);
    }
  }, [locale, messages.agent.historyCleared, showToast]);

  useEffect(() => {
    if (entries.length > 0) lastAnswerRef.current?.focus();
  }, [entries.length]);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
      // Leaving the page cancels the 60 s request instead of leaking it.
      askController.current?.abort();
      historyController.current?.abort();
    },
    [],
  );

  const ask = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (text.length === 0 || asking) return;
      const controller = new AbortController();
      askController.current?.abort();
      askController.current = controller;
      setAsking(true);
      try {
        const response = await api.agentAsk(text, controller.signal);
        setEntries((previous) => [
          ...previous,
          { run: response.run, sources: response.sources, truncated: response.truncated },
        ]);
        setQuestion('');
      } catch (failure: unknown) {
        if (isAbortError(failure)) return;
        showToast(`${messages.agent.errorTitle} ${formatApiError(failure, locale)}`, {
          tone: 'bad',
        });
      } finally {
        setAsking(false);
      }
    },
    [asking, locale, messages.agent.errorTitle, showToast],
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
            {status?.provider ? <span className="sf-agent-model">{status.provider}</span> : null}
            {status?.model ? <span className="sf-agent-model numeric">{status.model}</span> : null}
            <Button
              variant={historyOpen ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => {
                setSettingsOpen(false);
                setHistoryOpen((open) => !open);
              }}
            >
              {messages.agent.history}
            </Button>
            <Button
              variant={settingsOpen ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => {
                setHistoryOpen(false);
                setSettingsOpen((open) => !open);
              }}
            >
              {settingsOpen
                ? locale === 'de'
                  ? 'Zurück zum Chat'
                  : 'Back to chat'
                : messages.navItems.settings}
            </Button>
            {!settingsOpen && !historyOpen && entries.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={asking}
                onClick={() => {
                  setEntries([]);
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

      {settingsOpen ? (
        <div className="sf-agent-settings sf-agent-column">
          <Card>
            <CardHeader
              title={locale === 'de' ? 'Chat-Einstellungen' : 'Chat settings'}
              meta={
                locale === 'de'
                  ? 'Standardmäßig werden der aktive Standard-Provider und sein Standardmodell verwendet.'
                  : 'By default, the active default provider and its default model are used.'
              }
            />
            <div className="sf-card-body sf-agent-settings-body">
              <div className="sf-agent-settings-active">
                <span className="label">
                  {locale === 'de' ? 'Aktuell aktiv' : 'Currently active'}
                </span>
                <div className="sf-agent-settings-active-val">
                  <Badge tone={configured ? 'good' : 'warn'}>
                    {configured ? messages.agent.ready : messages.agent.notConfigured}
                  </Badge>
                  {status?.provider ? (
                    <span className="sf-agent-model">{status.provider}</span>
                  ) : null}
                  {status?.model ? (
                    <span className="sf-agent-model numeric">{status.model}</span>
                  ) : null}
                </div>
              </div>

              <div className="sf-llm-grid-2">
                <div className="sf-field">
                  <div className="sf-llm-field-label">
                    <label className="label" htmlFor="sf-chat-provider">
                      {messages.llm.colProvider}
                    </label>
                    <HelpTip
                      text={
                        locale === 'de'
                          ? 'Automatisch übernimmt den Standard-Provider.'
                          : 'Automatic uses the default provider.'
                      }
                    />
                  </div>
                  <select
                    id="sf-chat-provider"
                    className="sf-input"
                    value={selectedProviderId}
                    onChange={(event) => {
                      setSelectedProviderId(event.target.value);
                      setSelectedModelId('');
                    }}
                  >
                    <option value="">
                      {locale === 'de' ? 'Automatisch (Standard)' : 'Automatic (default)'}
                    </option>
                    {providers.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="sf-field">
                  <div className="sf-llm-field-label">
                    <label className="label" htmlFor="sf-chat-model">
                      {messages.llm.modelLabel}
                    </label>
                    <HelpTip
                      text={
                        locale === 'de'
                          ? 'Optionales Modell für den gewählten Provider.'
                          : 'Optional model override for the selected provider.'
                      }
                    />
                  </div>
                  <select
                    id="sf-chat-model"
                    className="sf-input"
                    value={selectedModelId}
                    disabled={!selectedProviderId || models.length === 0}
                    onChange={(event) => setSelectedModelId(event.target.value)}
                  >
                    <option value="">
                      {locale === 'de' ? 'Standardmodell des Providers' : 'Provider default model'}
                    </option>
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.modelKey}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="sf-agent-settings-foot">
                <Button variant="ghost" size="sm" onClick={() => navigate('/llm')}>
                  {locale === 'de' ? 'LLM-Provider verwalten' : 'Manage LLM providers'}
                </Button>
                <div className="sf-agent-settings-actions">
                  <Button variant="secondary" size="sm" onClick={() => setSettingsOpen(false)}>
                    {messages.common.cancel}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={savingSettings}
                    onClick={() => void saveSettings()}
                  >
                    {savingSettings ? messages.llm.saving : messages.llm.saveProvider}
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        </div>
      ) : historyOpen ? (
        <div className="sf-agent-history sf-agent-column">
          <Card>
            <CardHeader
              title={messages.agent.historyTitle}
              meta={messages.agent.historyDescription}
            />
            <div className="sf-card-body sf-agent-history-body">
              <div className="sf-agent-history-tools">
                <div className="sf-agent-history-search">
                  <Input
                    id="sf-agent-history-search"
                    type="search"
                    aria-label={messages.agent.historySearchLabel}
                    placeholder={messages.agent.historySearchPlaceholder}
                    value={historyQuery}
                    onChange={(event) => setHistoryQuery(event.target.value)}
                  />
                </div>
                <span className="sf-field-hint numeric">
                  {messages.agent.historySummary(historyItems.length, historyTotal)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={historyBusy || historyTotal === 0}
                  onClick={() => setClearOpen(true)}
                >
                  {messages.agent.clearHistory}
                </Button>
              </div>

              {historyLoading && historyItems.length === 0 ? (
                <p className="sf-agent-history-empty">{messages.agent.historyLoading}</p>
              ) : historyItems.length === 0 ? (
                <div className="sf-agent-history-empty">
                  <p className="sf-agent-history-empty-title">
                    {historyQuery.trim().length > 0 && historyLoaded
                      ? messages.agent.historyNoMatch
                      : messages.agent.historyEmptyTitle}
                  </p>
                  {historyQuery.trim().length === 0 ? (
                    <p>{messages.agent.historyEmptyDescription}</p>
                  ) : null}
                </div>
              ) : (
                <ul className="sf-agent-history-list">
                  {historyItems.map((run) => (
                    <li key={run.id} className="sf-agent-history-row">
                      <div className="sf-agent-history-main">
                        <button
                          type="button"
                          className="sf-agent-history-question"
                          onClick={() => openRun(run)}
                        >
                          {run.question}
                        </button>
                        <p className="sf-agent-history-preview">
                          {run.answer ?? messages.agent.emptyAnswer}
                        </p>
                        <div className="sf-agent-history-meta">
                          <span className="numeric">{formatDateTime(run.createdAt, locale)}</span>
                          {run.status === 'error' ? (
                            <Badge tone="bad">
                              {run.errorCode ?? messages.agent.stepError}
                            </Badge>
                          ) : null}
                          {run.model ? (
                            <span className="sf-agent-history-model">{run.model}</span>
                          ) : null}
                        </div>
                      </div>
                      <div className="sf-agent-history-actions">
                        <Button variant="secondary" size="sm" onClick={() => openRun(run)}>
                          {messages.agent.historyOpen}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={historyBusy}
                          aria-label={messages.agent.historyDelete}
                          onClick={() => setDeleteTarget(run)}
                        >
                          {messages.agent.historyDelete}
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className="sf-agent-history-foot">
                <span className="sf-field-hint">
                  {messages.agent.historyRetention(status?.retentionDays ?? 90)}
                </span>
                {historyCursor ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={historyLoading}
                    onClick={() =>
                      void loadHistory({ append: true, q: historyQuery.trim() || undefined })
                    }
                  >
                    {messages.agent.historyLoadMore}
                  </Button>
                ) : null}
              </div>
            </div>
          </Card>
        </div>
      ) : (
        <>
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
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button variant="secondary" size="sm" onClick={reloadStatus}>
                  {messages.agent.checkStatus}
                </Button>
                <Button variant="primary" size="sm" onClick={() => navigate('/llm')}>
                  {messages.llm.title}
                </Button>
              </div>
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
                  {asking ? (
                    <span className="sf-agent-working-inline">
                      <span className="sf-agent-pulse-dot" aria-hidden="true" />
                      {messages.agent.thinking}
                    </span>
                  ) : (
                    messages.agent.hint
                  )}
                </span>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={disabled || question.trim().length === 0}
                  onClick={() => void ask(question)}
                >
                  {asking ? (
                    <span className="sf-agent-btn-dots" aria-label={messages.agent.thinking}>
                      <span />
                      <span />
                      <span />
                    </span>
                  ) : (
                    messages.agent.send
                  )}
                </Button>
              </div>
            </div>

            {asking ? (
              <div className="sf-agent-thinking" role="status" aria-live="polite">
                <div className="sf-agent-thinking-head">
                  <span className="sf-agent-pulse-dot" aria-hidden="true" />
                  <span className="label">{messages.agent.title}</span>
                  <span className="sf-agent-thinking-label">{messages.agent.thinking}</span>
                </div>
                <div className="sf-agent-thinking-lines" aria-hidden="true">
                  <div className="sf-agent-shimmer" style={{ width: '82%' }} />
                  <div className="sf-agent-shimmer" style={{ width: '64%' }} />
                  <div className="sf-agent-shimmer" style={{ width: '44%' }} />
                </div>
              </div>
            ) : null}

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

          {asking ? (
            <div className="sf-agent-thinking" role="status" aria-live="polite">
              <div className="sf-agent-thinking-head">
                <span className="sf-agent-pulse-dot" aria-hidden="true" />
                <span className="label">{messages.agent.title}</span>
                <span className="sf-agent-thinking-label">{messages.agent.thinking}</span>
              </div>
              <div className="sf-agent-thinking-lines" aria-hidden="true">
                <div className="sf-agent-shimmer" style={{ width: '82%' }} />
                <div className="sf-agent-shimmer" style={{ width: '64%' }} />
                <div className="sf-agent-shimmer" style={{ width: '44%' }} />
              </div>
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
                {asking ? (
                  <span className="sf-agent-working-inline">
                    <span className="sf-agent-pulse-dot" aria-hidden="true" />
                    {messages.agent.thinking}
                  </span>
                ) : (
                  messages.agent.hint
                )}
              </span>
              <Button
                variant="primary"
                size="sm"
                disabled={disabled || question.trim().length === 0}
                onClick={() => void ask(question)}
              >
                {asking ? (
                  <span className="sf-agent-btn-dots" aria-label={messages.agent.thinking}>
                    <span />
                    <span />
                    <span />
                  </span>
                ) : (
                  messages.agent.send
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
        </>
      )}

      <ConfirmModal
        open={deleteTarget !== null}
        title={messages.agent.historyDeleteTitle}
        description={messages.agent.historyDeleteBody}
        confirmLabel={messages.agent.historyDelete}
        cancelLabel={messages.common.cancel}
        closeLabel={messages.common.close}
        danger
        busy={historyBusy}
        onConfirm={() => void deleteRun()}
        onCancel={() => setDeleteTarget(null)}
      />

      <ConfirmModal
        open={clearOpen}
        title={messages.agent.historyClearTitle}
        description={messages.agent.historyClearBody}
        confirmLabel={messages.agent.clearHistory}
        cancelLabel={messages.common.cancel}
        closeLabel={messages.common.close}
        danger
        busy={historyBusy}
        onConfirm={() => void clearAll()}
        onCancel={() => setClearOpen(false)}
      />
    </div>
  );
}
