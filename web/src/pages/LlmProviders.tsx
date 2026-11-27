import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { HelpTip } from '../components/HelpTip';
import { SparklesIcon } from '../components/icons';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmModal,
  EmptyState,
  Field,
  Input,
  KpiTile,
  PageHeader,
} from '../components/ui';
import { useToast } from '../components/useToast';
import { ApiError, api, isAbortError } from '../lib/api';
import {
  formatApiError,
  formatDateShort,
  formatDateTime,
  type Locale,
  type Messages,
} from '../lib/i18n';
import { AppLink, navigate } from '../lib/router';
import type {
  LlmAuthStyle,
  LlmLogEntry,
  LlmLogLevel,
  LlmModel,
  LlmModelInput,
  LlmPluginConsumer,
  LlmProvider,
  LlmProviderInput,
  LlmUsageSummary,
} from '../lib/types';

const PAGE_SIZE = 25;

/**
 * Provider templates that connect through a browser login. A template never
 * prefills the manual form: the backend runs the provider's device flow and
 * creates the provider with a sealed key, so no secret is typed or copied.
 */
interface ProviderTemplate {
  id: string;
  label: string;
  /** Shown under the title: what the browser login does. */
  note: { de: string; en: string };
  docs: string;
}

const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    id: 'martllm',
    label: 'MartLLM',
    note: {
      de: 'Per Browser-Login verbinden: Link öffnen, anmelden, Verbindung bestätigen. Der Key wird automatisch versiegelt gespeichert.',
      en: 'Connect via browser login: open the link, sign in, approve the connection. The key is stored sealed automatically.',
    },
    docs: 'https://martllm.com/de/docs',
  },
];

/** A stored URL the operator may want to open: shown as a real link, never as raw text. */
function ExternalLink({
  href,
  children,
  className,
}: {
  href: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className ?? 'numeric sf-text-link'}
    >
      {children ?? href}
    </a>
  );
}

export function formatCost(costMicros: number, locale: Locale): string {
  const euros = costMicros / 1_000_000;
  return new Intl.NumberFormat(locale === 'de' ? 'de-DE' : 'en-GB', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 2,
  }).format(euros);
}

export function formatTokens(value: number, locale: Locale): string {
  if (value < 1000) return String(value);
  return new Intl.NumberFormat(locale === 'de' ? 'de-DE' : 'en-GB', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

function numberOrZero(raw: string): number {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function errorField(error: unknown, key: string): string | undefined {
  if (error instanceof ApiError) return error.fields[key];
  return undefined;
}

export interface LlmProvidersPageProps {
  locale: Locale;
  messages: Messages;
}

type ListTab = 'providers' | 'usage' | 'logs';

export function LlmProvidersPage({ locale, messages }: LlmProvidersPageProps) {
  const showToast = useToast();
  const [tab, setTab] = useState<ListTab>('providers');
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [summary, setSummary] = useState<LlmUsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    if (reloadNonce === 0) setLoading(true);
    setError(null);
    Promise.all([
      api.listLlmProviders({ limit: PAGE_SIZE }, controller.signal),
      api.llmUsageSummary(30, controller.signal),
    ])
      .then(([providerPage, usageSummary]) => {
        setProviders(providerPage.items);
        setSummary(usageSummary);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        setError(formatApiError(err, locale));
        setLoading(false);
      });
    return () => controller.abort();
  }, [locale, reloadNonce]);

  async function makeDefaultProvider(provider: LlmProvider): Promise<void> {
    try {
      await api.updateLlmProvider(provider.id, { isDefault: true });
      showToast(messages.llm.saved);
      setReloadNonce((value) => value + 1);
    } catch (err) {
      showToast(formatApiError(err, locale), { tone: 'bad' });
    }
  }

  const activeProviders = providers.filter((provider) => provider.status === 'active').length;
  const modelCount = providers.reduce((sum, provider) => sum + provider.modelCount, 0);

  return (
    <div>
      <PageHeader
        title={messages.llm.title}
        description={messages.llm.description}
        actions={
          <Button variant="primary" onClick={() => navigate('/llm/new')}>
            {messages.llm.addProvider}
          </Button>
        }
      />

      <div className="sf-kpi-grid">
        <KpiTile
          label={messages.llm.kpiProviders}
          value={loading ? '—' : `${activeProviders}/${providers.length}`}
          hint={messages.llm.kpiProvidersHint}
          icon={<SparklesIcon size={15} />}
        />
        <KpiTile
          label={messages.llm.kpiModels}
          value={loading ? '—' : modelCount}
          hint={messages.llm.kpiModelsHint}
        />
        <KpiTile
          label={messages.llm.kpiCalls}
          value={loading || !summary ? '—' : formatTokens(summary.calls, locale)}
          hint={messages.llm.kpiCallsHint}
          tone={summary && summary.errors > 0 ? 'warn' : 'neutral'}
        />
        <KpiTile
          label={messages.llm.kpiCost}
          value={loading || !summary ? '—' : formatCost(summary.costMicros, locale)}
          hint={messages.llm.kpiCostHint}
        />
      </div>

      <div className="sf-stack">
        {error ? (
          <div className="sf-alert sf-alert-bad" role="alert">
            <span>{error}</span>
          </div>
        ) : null}

        <Card>
          <div className="sf-toolbar">
            <div className="sf-tabs" role="group" aria-label={messages.llm.title}>
              <button
                type="button"
                aria-pressed={tab === 'providers'}
                onClick={() => setTab('providers')}
                className={tab === 'providers' ? 'sf-tab sf-tab-active' : 'sf-tab'}
              >
                <span>{messages.llm.providersTitle}</span>
                <span className="sf-tab-count">{loading ? '—' : providers.length}</span>
              </button>
              <button
                type="button"
                aria-pressed={tab === 'usage'}
                onClick={() => setTab('usage')}
                className={tab === 'usage' ? 'sf-tab sf-tab-active' : 'sf-tab'}
              >
                <span>{messages.llm.usageTitle}</span>
                <span className="sf-tab-count">
                  {loading || !summary ? '—' : summary.calls}
                </span>
              </button>
              <button
                type="button"
                aria-pressed={tab === 'logs'}
                onClick={() => setTab('logs')}
                className={tab === 'logs' ? 'sf-tab sf-tab-active' : 'sf-tab'}
              >
                <span>{messages.llm.logsTitle}</span>
              </button>
            </div>
          </div>

          {loading ? (
            <div className="sf-card-body">
              <span className="numeric">{messages.common.loadingPlatform}</span>
            </div>
          ) : tab === 'providers' ? (
            providers.length === 0 ? (
              <EmptyState
                title={messages.llm.emptyTitle}
                description={messages.llm.emptyDescription}
                action={
                  <Button variant="primary" onClick={() => navigate('/llm/new')}>
                    {messages.llm.addProvider}
                  </Button>
                }
              />
            ) : (
              <div className="sf-table-wrap">
                <table className="sf-table">
                  <thead>
                    <tr>
                      <th scope="col" className="label">
                        {messages.llm.colProvider}
                      </th>
                      <th scope="col" className="label">
                        {messages.llm.colType}
                      </th>
                      <th scope="col" className="label">
                        {messages.llm.colModels}
                      </th>
                      <th scope="col" className="label">
                        {messages.llm.colAccess}
                      </th>
                      <th scope="col" className="label">
                        {messages.llm.colLastTest}
                      </th>
                      <th scope="col" className="label">
                        {messages.llm.defaultLabel}
                      </th>
                      <th scope="col" className="label">
                        {messages.llm.colStatus}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {providers.map((provider) => (
                      <tr key={provider.id}>
                        <td>
                          <AppLink to={`/llm/${provider.id}`} className="sf-tenant-name">
                            {provider.name}
                          </AppLink>
                          <div className="sf-tenant-slug">
                            <ExternalLink href={provider.baseUrl} />
                          </div>
                        </td>
                        <td>
                          <Badge tone={provider.preset === 'custom' ? 'accent' : 'neutral'}>
                            {provider.preset === 'custom' ? 'Custom' : provider.preset}
                          </Badge>
                        </td>
                        <td>
                          <span className="numeric">{provider.modelCount}</span>
                        </td>
                        <td>
                          {provider.allowedPlugins === null
                            ? messages.llm.allPlugins
                            : provider.allowedPlugins.join(', ')}
                        </td>
                        <td>
                          <span className="numeric">
                            {provider.lastTestAt
                              ? `${formatDateShort(provider.lastTestAt, locale)} · ${
                                  provider.lastTestMs ?? 0
                                } ms`
                              : messages.llm.neverTested}
                          </span>
                        </td>
                        <td>
                          {provider.isDefault || providers.length === 1 ? (
                            <Badge tone="accent">{messages.llm.defaultLabel}</Badge>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void makeDefaultProvider(provider)}
                            >
                              {messages.llm.makeDefault}
                            </Button>
                          )}
                        </td>
                        <td>
                          <Badge tone={provider.status === 'active' ? 'good' : 'neutral'}>
                            {provider.status === 'active'
                              ? messages.llm.statusActive
                              : messages.llm.statusDisabled}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : tab === 'usage' ? (
            <UsageTable locale={locale} messages={messages} summary={summary} />
          ) : (
            <PluginLogsTable locale={locale} messages={messages} />
          )}
        </Card>
      </div>
    </div>
  );
}

function PluginLogsTable({ locale, messages }: { locale: Locale; messages: Messages }) {
  const [items, setItems] = useState<LlmLogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [levelFilter, setLevelFilter] = useState<'' | LlmLogLevel>('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    if (reloadNonce === 0) setLoading(true);
    setError(null);
    api
      .listLlmLogs(
        {
          limit: PAGE_SIZE,
          ...(levelFilter ? { level: levelFilter } : {}),
        },
        controller.signal,
      )
      .then((page) => {
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        setError(formatApiError(err, locale));
        setLoading(false);
      });
    return () => controller.abort();
  }, [levelFilter, reloadNonce, locale]);

  async function handleLoadMore(): Promise<void> {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.listLlmLogs({
        limit: PAGE_SIZE,
        cursor: nextCursor,
        ...(levelFilter ? { level: levelFilter } : {}),
      });
      setItems((prev) => [...prev, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(formatApiError(err, locale));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div>
      <div
        className="sf-card-body"
        style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}
      >
        <select
          className="sf-input"
          aria-label={messages.llm.logsLevel}
          value={levelFilter}
          onChange={(event) => {
            const val = event.target.value;
            setLevelFilter(val === 'info' || val === 'warn' || val === 'error' ? val : '');
          }}
          style={{ maxWidth: 180 }}
        >
          <option value="">{messages.llm.logsAllLevels}</option>
          <option value="info">{messages.llm.logsLevelInfo}</option>
          <option value="warn">{messages.llm.logsLevelWarn}</option>
          <option value="error">{messages.llm.logsLevelError}</option>
        </select>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setReloadNonce((value) => value + 1)}
          disabled={loading}
        >
          {messages.llm.logsRefresh}
        </Button>
      </div>

      {error ? (
        <div className="sf-card-body">
          <div className="sf-alert sf-alert-bad" role="alert">
            <span>{error}</span>
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="sf-card-body">
          <span className="numeric">{messages.common.loadingPlatform}</span>
        </div>
      ) : items.length === 0 ? (
        <EmptyState title={messages.llm.logsTitle} description={messages.llm.logsEmpty} />
      ) : (
        <div className="sf-table-wrap">
          <table className="sf-table">
            <thead>
              <tr>
                <th scope="col" className="label">
                  {messages.llm.usageWhen}
                </th>
                <th scope="col" className="label">
                  {messages.llm.logsLevel}
                </th>
                <th scope="col" className="label">
                  {messages.llm.logsAction}
                </th>
                <th scope="col" className="label">
                  {messages.llm.colProvider}
                </th>
                <th scope="col" className="label">
                  {messages.llm.logsMessage}
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <span className="numeric">{formatDateTime(entry.createdAt, locale)}</span>
                  </td>
                  <td>
                    <Badge
                      tone={
                        entry.level === 'error'
                          ? 'bad'
                          : entry.level === 'warn'
                            ? 'warn'
                            : 'neutral'
                      }
                    >
                      {entry.level === 'error'
                        ? messages.llm.logsLevelError
                        : entry.level === 'warn'
                          ? messages.llm.logsLevelWarn
                          : messages.llm.logsLevelInfo}
                    </Badge>
                  </td>
                  <td>
                    <span className="numeric">{entry.action}</span>
                  </td>
                  <td>{entry.providerName ?? entry.providerId ?? '—'}</td>
                  <td>{entry.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {nextCursor ? (
            <div className="sf-card-body">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleLoadMore()}
                disabled={loadingMore}
              >
                {messages.llm.logsLoadMore}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function UsageTable({
  locale,
  messages,
  summary,
}: {
  locale: Locale;
  messages: Messages;
  summary: LlmUsageSummary | null;
}) {
  if (!summary || summary.calls === 0) {
    return <EmptyState title={messages.llm.usageTitle} description={messages.llm.usageEmpty} />;
  }
  return (
    <div className="sf-table-wrap">
      <table className="sf-table">
        <thead>
          <tr>
            <th scope="col" className="label">
              {messages.llm.usageCaller}
            </th>
            <th scope="col" className="label">
              {messages.llm.usageTokens}
            </th>
            <th scope="col" className="label">
              {messages.llm.usageCost}
            </th>
          </tr>
        </thead>
        <tbody>
          {summary.byCaller.map((row) => (
            <tr key={row.caller}>
              <td>{row.caller}</td>
              <td>
                <span className="numeric">
                  {formatTokens(row.tokens, locale)} · {row.calls}
                </span>
              </td>
              <td>
                <span className="numeric">{formatCost(row.costMicros, locale)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="sf-card-body">
        <div className="label">{messages.llm.usageMeta(summary.days)}</div>
        <div className="sf-kv-list">
          {summary.byPurpose.map((purpose) => (
            <div key={purpose.purpose} className="sf-kv-row">
              <span className="numeric">{purpose.purpose}</span>
              <span className="numeric">
                {purpose.calls} · {formatCost(purpose.costMicros, locale)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// --- Form ------------------------------------------------------------------

function LlmField({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="sf-field">
      <div className="sf-llm-field-head">
        <label className="label" htmlFor={htmlFor}>
          {label}
        </label>
        {hint ? <HelpTip text={hint} /> : null}
      </div>
      {children}
      {error ? (
        <div className="sf-field-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function PresetPills({
  options,
  value,
  onSelect,
}: {
  options: Array<{ label: string; value: string }>;
  value: string;
  onSelect: (next: string) => void;
}) {
  return (
    <div className="sf-preset-row">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="sf-preset-pill"
          aria-pressed={value === option.value}
          onClick={() => onSelect(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const FALLBACK_PLUGINS: LlmPluginConsumer[] = [
  { id: 'agent', label: 'Agent', description: '', needsLlm: true },
  { id: 'automation-discovery', label: 'Automatisierungs-Check', description: '', needsLlm: true },
  { id: 'websites', label: 'Webseiten', description: '', needsLlm: true },
  { id: 'tenants', label: 'Mandanten', description: '', needsLlm: false },
];

function PluginAccessDropdown({
  id,
  plugins,
  selected,
  allLabel,
  resetLabel,
  onChange,
}: {
  id: string;
  plugins: LlmPluginConsumer[];
  selected: string[];
  allLabel: string;
  resetLabel: string;
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  function togglePlugin(pluginId: string): void {
    if (selected.includes(pluginId)) {
      onChange(selected.filter((item) => item !== pluginId));
    } else {
      onChange([...selected, pluginId]);
    }
  }

  const labelById = new Map(plugins.map((p) => [p.id, p.label]));
  const summaryText =
    selected.length === 0
      ? allLabel
      : selected.map((pluginId) => labelById.get(pluginId) ?? pluginId).join(', ');

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        id={id}
        type="button"
        className="sf-input"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          width: '100%',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {summaryText}
        </span>
        <span aria-hidden="true" style={{ fontSize: 11, opacity: 0.7 }}>
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open ? (
        <div
          role="listbox"
          aria-multiselectable="true"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            zIndex: 30,
            background: 'var(--color-paper-raised)',
            border: '1px solid var(--color-line-strong)',
            borderRadius: 6,
            padding: 6,
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.25)',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            maxHeight: 260,
            overflowY: 'auto',
          }}
        >
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 8px',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: selected.length === 0 ? 600 : 400,
            }}
          >
            <input
              type="checkbox"
              checked={selected.length === 0}
              onChange={() => onChange([])}
            />
            <span>{allLabel}</span>
          </label>
          <div style={{ borderTop: '1px solid var(--color-line)', margin: '4px 0' }} />
          {plugins.map((plugin) => {
            const checked = selected.includes(plugin.id);
            return (
              <label
                key={plugin.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 8px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => togglePlugin(plugin.id)}
                />
                <span>
                  {plugin.label}{' '}
                  <span style={{ opacity: 0.65, fontSize: 12 }}>
                    ({plugin.id}){plugin.needsLlm ? ' · KI' : ''}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      ) : null}

      {selected.length > 0 ? (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
            marginTop: 8,
            alignItems: 'center',
          }}
        >
          {selected.map((pluginId) => {
            const label = labelById.get(pluginId) ?? pluginId;
            return (
              <span
                key={pluginId}
                className="sf-badge sf-badge-neutral"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <span>{label}</span>
                <button
                  type="button"
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 0,
                    fontSize: 13,
                    lineHeight: 1,
                    color: 'inherit',
                  }}
                  aria-label={`${label} entfernen`}
                  onClick={() => onChange(selected.filter((item) => item !== pluginId))}
                >
                  ×
                </button>
              </span>
            );
          })}
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange([])}>
            {resetLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export interface LlmProviderFormPageProps {
  locale: Locale;
  messages: Messages;
  providerId?: string;
}

export function LlmProviderFormPage({ locale, messages, providerId }: LlmProviderFormPageProps) {
  const showToast = useToast();
  const editing = Boolean(providerId);
  const [name, setName] = useState('');
  const [preset, setPreset] = useState('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [chatPath, setChatPath] = useState('/chat/completions');
  const [apiKey, setApiKey] = useState('');
  const [timeoutSeconds, setTimeoutSeconds] = useState('30');
  const [retries, setRetries] = useState('1');
  const [rate, setRate] = useState('60');
  const [daily, setDaily] = useState('0');
  const [monthly, setMonthly] = useState('0');
  const [retention, setRetention] = useState('90');
  const [allowedPlugins, setAllowedPlugins] = useState<string[]>([]);
  const [availablePlugins, setAvailablePlugins] = useState<LlmPluginConsumer[]>(FALLBACK_PLUGINS);
  const [status, setStatus] = useState<'active' | 'disabled'>('active');
  const [keySet, setKeySet] = useState(false);
  const [loading, setLoading] = useState(editing);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | undefined>>({});
  const [martLink, setMartLink] = useState<{
    deviceCode: string;
    verificationUrl: string;
    linkCode: string;
    interval: number;
  } | null>(null);
  const [martStarting, setMartStarting] = useState(false);

  useEffect(() => {
    if (!martLink) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void api
        .pollMartLlmLink(martLink.deviceCode, name.trim() || undefined)
        .then((res) => {
          if (cancelled) return;
          if (res.status === 'approved') {
            setMartLink(null);
            showToast(
              locale === 'de'
                ? 'MartLLM erfolgreich verbunden.'
                : 'MartLLM connected successfully.',
              { tone: 'good' },
            );
            navigate(`/llm/${res.provider.id}`);
          } else if (res.status === 'denied') {
            setMartLink(null);
            setError(
              locale === 'de'
                ? 'Anmeldung bei MartLLM im Browser abgelehnt.'
                : 'MartLLM browser login was denied.',
            );
          } else if (res.status === 'expired') {
            setMartLink(null);
            setError(
              locale === 'de'
                ? 'MartLLM-Anmeldelink ist abgelaufen. Bitte erneut starten.'
                : 'MartLLM login link expired. Please start again.',
            );
          }
        })
        .catch(() => {
          // transient poll errors are retried on next interval
        });
    }, Math.max(2, martLink.interval) * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [martLink, name, locale, showToast]);

  async function handleStartMartLlm(): Promise<void> {
    setMartStarting(true);
    setError(null);
    try {
      const started = await api.startMartLlmLink();
      setMartLink({
        deviceCode: started.deviceCode,
        verificationUrl: started.verificationUrl,
        linkCode: started.linkCode,
        interval: started.interval,
      });
    } catch (err) {
      setError(formatApiError(err, locale));
    } finally {
      setMartStarting(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    api
      .listLlmPlugins(controller.signal)
      .then((items) => {
        if (items.length > 0) setAvailablePlugins(items);
      })
      .catch(() => {
        // Fallback list stays active when plugin discovery is unavailable.
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!providerId) return;
    const controller = new AbortController();
    api
      .getLlmProvider(providerId, controller.signal)
      .then((provider) => {
        setName(provider.name);
        setPreset(provider.preset || 'openai');
        setBaseUrl(provider.baseUrl);
        setChatPath(provider.chatPath || '/chat/completions');
        setKeySet(provider.keySet);
        setTimeoutSeconds(String(Math.round(provider.timeoutMs / 1000)));
        setRetries(String(provider.maxRetries));
        setRate(String(provider.rateLimitPerMinute));
        setDaily(String(provider.dailyTokenLimit));
        setMonthly(String(provider.monthlyBudgetMicros / 1_000_000));
        setRetention(String(provider.retentionDays));
        setAllowedPlugins(provider.allowedPlugins ?? []);
        setStatus(provider.status);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        setError(formatApiError(err, locale));
        setLoading(false);
      });
    return () => controller.abort();
  }, [providerId, locale]);

  function buildInput(): LlmProviderInput {
    const authStyle: LlmAuthStyle = apiKey.trim() || (editing && keySet) ? 'bearer' : 'none';
    const input: LlmProviderInput = {
      name: name.trim(),
      preset: preset.trim() || 'openai',
      baseUrl: baseUrl.trim(),
      chatPath: chatPath.trim() || '/chat/completions',
      authStyle,
      timeoutMs: numberOrZero(timeoutSeconds) * 1000,
      maxRetries: numberOrZero(retries),
      rateLimitPerMinute: numberOrZero(rate),
      dailyTokenLimit: numberOrZero(daily),
      monthlyBudgetMicros: Math.round(Number.parseFloat(monthly) * 1_000_000) || 0,
      retentionDays: numberOrZero(retention),
      allowedPlugins: allowedPlugins.length > 0 ? allowedPlugins : null,
      status,
    };
    if (apiKey.trim()) input.apiKey = apiKey.trim();
    return input;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      const input = buildInput();
      if (providerId) {
        await api.updateLlmProvider(providerId, input);
        showToast(messages.llm.saved);
        navigate(`/llm/${providerId}`);
      } else {
        const created = await api.createLlmProvider(input);
        showToast(messages.llm.saved);
        navigate(`/llm/${created.id}`);
      }
    } catch (err) {
      setFieldErrors({
        name: errorField(err, 'name'),
        baseUrl: errorField(err, 'baseUrl'),
        apiKey: errorField(err, 'apiKey'),
        allowedPlugins: errorField(err, 'allowedPlugins'),
      });
      setError(formatApiError(err, locale));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest(): Promise<void> {
    setTesting(true);
    setError(null);
    try {
      const input = buildInput();
      const result = providerId
        ? await api.testLlmProvider({ ...input, providerId })
        : await api.testLlmProvider(input);
      showToast(
        result.ok
          ? messages.llm.testOk(result.latencyMs, result.models?.length ?? 0)
          : `${messages.llm.testFailed}${result.message ? ` — ${result.message}` : ''}`,
        { tone: result.ok ? 'good' : 'bad' },
      );
    } catch (err) {
      showToast(formatApiError(err, locale), { tone: 'bad' });
    } finally {
      setTesting(false);
    }
  }

  if (loading) {
    return (
      <div>
        <span className="numeric">{messages.common.loadingPlatform}</span>
      </div>
    );
  }

  const aiPlugins = availablePlugins.filter((p) => p.needsLlm);
  const otherPlugins = availablePlugins.filter((p) => !p.needsLlm);
  const orderedPlugins = [...aiPlugins, ...otherPlugins];

  return (
    <div>
      <PageHeader
        title={editing ? messages.llm.editTitle : messages.llm.newTitle}
        description={messages.llm.newDescription}
        actions={
          <Button variant="secondary" onClick={() => navigate('/llm')}>
            {messages.llm.backToList}
          </Button>
        }
      />

      <div className="sf-stack">
        {error ? (
          <div className="sf-alert sf-alert-bad" role="alert">
            <span>{error}</span>
          </div>
        ) : null}

        {!editing ? (
          <Card>
            <CardHeader
              title={locale === 'de' ? 'Provider-Templates' : 'Provider templates'}
              meta={
                locale === 'de'
                  ? 'Browser-Anmeldung: kein API-Key zum Kopieren.'
                  : 'Browser login: no API key to copy.'
              }
            />
            <div className="sf-card-body">
              {martLink ? (
                <div className="sf-stack" style={{ gap: 10 }}>
                  <div>
                    {locale === 'de'
                      ? '1. Öffne den Link im Browser, melde dich bei MartLLM an und bestätige die Verbindung:'
                      : '1. Open the link in your browser, sign in to MartLLM and approve the connection:'}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                    <a
                      href={martLink.verificationUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="sf-btn sf-btn-primary"
                    >
                      {locale === 'de' ? 'MartLLM im Browser öffnen' : 'Open MartLLM in browser'}
                    </a>
                    {martLink.linkCode ? (
                      <span className="numeric" style={{ fontSize: 15, fontWeight: 600 }}>
                        Code: {martLink.linkCode}
                      </span>
                    ) : null}
                    <Button variant="ghost" size="sm" onClick={() => setMartLink(null)}>
                      {locale === 'de' ? 'Abbrechen' : 'Cancel'}
                    </Button>
                  </div>
                  <div style={{ fontSize: 12 }}>
                    <ExternalLink href={martLink.verificationUrl} />
                  </div>
                  <div style={{ fontSize: 13, opacity: 0.8 }}>
                    {locale === 'de'
                      ? 'Warte auf Bestätigung im Browser… der Provider wird danach automatisch angelegt.'
                      : 'Waiting for browser approval… the provider will be created automatically.'}
                  </div>
                </div>
              ) : (
                <>
                  <div className="sf-template-grid">
                    {PROVIDER_TEMPLATES.map((template) => (
                      <div key={template.id} className="sf-template-card">
                        <span className="sf-template-name">{template.label}</span>
                        <span className="sf-template-note">{template.note[locale]}</span>
                        <div className="sf-template-actions">
                          <Button
                            type="button"
                            variant="primary"
                            onClick={() => void handleStartMartLlm()}
                            disabled={martStarting}
                          >
                            {martStarting
                              ? locale === 'de'
                                ? 'Verbindungslink wird erzeugt…'
                                : 'Creating login link…'
                              : locale === 'de'
                                ? 'Mit MartLLM verbinden'
                                : 'Connect with MartLLM'}
                          </Button>
                          <ExternalLink href={template.docs} className="sf-text-link">
                            {locale === 'de' ? 'Anleitung' : 'Docs'}
                          </ExternalLink>
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="sf-template-hint">
                    {locale === 'de'
                      ? 'Templates verbinden per Browser-Login. Einen Provider mit API-Key legst du unten im Formular an.'
                      : 'Templates connect through a browser login. A provider with an API key is created in the form below.'}
                  </p>
                </>
              )}
            </div>
          </Card>
        ) : null}

        <Card>
          <CardHeader title={editing ? messages.llm.editTitle : messages.llm.newTitle} />
          <div className="sf-card-body">
            <form onSubmit={handleSubmit} autoComplete="off">
              <div className="sf-llm-grid-2">
                <LlmField
                  label={messages.llm.nameLabel}
                  error={fieldErrors.name}
                  htmlFor="sf-llm-name"
                >
                  <Input
                    id="sf-llm-name"
                    name="llm-provider-name"
                    autoComplete="off"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={messages.llm.namePlaceholder}
                    invalid={Boolean(fieldErrors.name)}
                    maxLength={80}
                    required
                  />
                </LlmField>

                <LlmField
                  label={messages.llm.baseUrlLabel}
                  hint={messages.llm.baseUrlHint}
                  error={fieldErrors.baseUrl}
                  htmlFor="sf-llm-base-url"
                >
                  <Input
                    id="sf-llm-base-url"
                    name="llm-provider-base-url"
                    autoComplete="off"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder="https://api.openai.com/v1"
                    invalid={Boolean(fieldErrors.baseUrl)}
                    maxLength={500}
                    required
                  />
                </LlmField>

                <LlmField
                  label={messages.llm.apiKeyLabel}
                  hint={keySet ? messages.llm.apiKeyKeep : messages.llm.apiKeyHint}
                  error={fieldErrors.apiKey}
                  htmlFor="sf-llm-api-key"
                >
                  <Input
                    id="sf-llm-api-key"
                    name="llm-provider-api-key"
                    type="password"
                    autoComplete="new-password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={keySet ? '••••••••' : 'sk-…'}
                    invalid={Boolean(fieldErrors.apiKey)}
                  />
                </LlmField>

                <LlmField
                  label={messages.llm.allowedLabel}
                  hint={messages.llm.allowedHint}
                  error={fieldErrors.allowedPlugins}
                  htmlFor="sf-llm-allowed"
                >
                  <PluginAccessDropdown
                    id="sf-llm-allowed"
                    plugins={orderedPlugins}
                    selected={allowedPlugins}
                    allLabel={messages.llm.allPlugins}
                    resetLabel={messages.llm.resetToAllPlugins}
                    onChange={setAllowedPlugins}
                  />
                </LlmField>

                {editing ? (
                  <LlmField label={messages.llm.statusLabel} htmlFor="sf-llm-status">
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        minHeight: 38,
                      }}
                    >
                      <button
                        id="sf-llm-status"
                        type="button"
                        role="switch"
                        aria-checked={status === 'active'}
                        onClick={() =>
                          setStatus((current) => (current === 'active' ? 'disabled' : 'active'))
                        }
                        style={{
                          position: 'relative',
                          width: 44,
                          height: 24,
                          borderRadius: 999,
                          border: '1px solid var(--color-line-strong)',
                          background:
                            status === 'active' ? 'var(--color-good)' : 'var(--color-line)',
                          cursor: 'pointer',
                          padding: 0,
                          transition: 'background 150ms ease',
                          flexShrink: 0,
                        }}
                      >
                        <span
                          aria-hidden="true"
                          style={{
                            position: 'absolute',
                            top: 2,
                            left: status === 'active' ? 22 : 2,
                            width: 18,
                            height: 18,
                            borderRadius: '50%',
                            background: '#ffffff',
                            transition: 'left 150ms ease',
                            boxShadow: '0 1px 2px rgba(0, 0, 0, 0.25)',
                          }}
                        />
                      </button>
                      <span style={{ fontSize: 14 }}>
                        {status === 'active'
                          ? messages.llm.statusActive
                          : messages.llm.statusDisabled}
                      </span>
                    </div>
                  </LlmField>
                ) : null}
              </div>

              <details className="sf-llm-advanced">
                <summary>{messages.llm.advancedSettings}</summary>
                <div className="sf-llm-grid-3">
                  <LlmField label={messages.llm.timeoutLabel} htmlFor="sf-llm-timeout">
                    <Input
                      id="sf-llm-timeout"
                      type="number"
                      min={1}
                      max={120}
                      value={timeoutSeconds}
                      onChange={(event) => setTimeoutSeconds(event.target.value)}
                    />
                    <PresetPills
                      value={timeoutSeconds}
                      onSelect={setTimeoutSeconds}
                      options={[
                        { label: '10 s', value: '10' },
                        { label: '30 s', value: '30' },
                        { label: '60 s', value: '60' },
                        { label: '90 s', value: '90' },
                      ]}
                    />
                  </LlmField>

                  <LlmField label={messages.llm.retriesLabel} htmlFor="sf-llm-retries">
                    <Input
                      id="sf-llm-retries"
                      type="number"
                      min={0}
                      max={5}
                      value={retries}
                      onChange={(event) => setRetries(event.target.value)}
                    />
                    <PresetPills
                      value={retries}
                      onSelect={setRetries}
                      options={[
                        { label: '0', value: '0' },
                        { label: '1', value: '1' },
                        { label: '2', value: '2' },
                        { label: '3', value: '3' },
                        { label: '4', value: '4' },
                        { label: '5', value: '5' },
                      ]}
                    />
                  </LlmField>

                  <LlmField label={messages.llm.rateLabel} htmlFor="sf-llm-rate">
                    <Input
                      id="sf-llm-rate"
                      type="number"
                      min={1}
                      max={600}
                      value={rate}
                      onChange={(event) => setRate(event.target.value)}
                    />
                    <PresetPills
                      value={rate}
                      onSelect={setRate}
                      options={[
                        { label: '30', value: '30' },
                        { label: '60', value: '60' },
                        { label: '120', value: '120' },
                        { label: '300', value: '300' },
                      ]}
                    />
                  </LlmField>

                  <LlmField label={messages.llm.dailyLabel} htmlFor="sf-llm-daily">
                    <Input
                      id="sf-llm-daily"
                      type="number"
                      min={0}
                      value={daily}
                      onChange={(event) => setDaily(event.target.value)}
                    />
                    <PresetPills
                      value={daily}
                      onSelect={setDaily}
                      options={[
                        { label: 'Aus', value: '0' },
                        { label: '100k', value: '100000' },
                        { label: '500k', value: '500000' },
                        { label: '1M', value: '1000000' },
                      ]}
                    />
                  </LlmField>

                  <LlmField label={messages.llm.monthlyLabel} htmlFor="sf-llm-monthly">
                    <Input
                      id="sf-llm-monthly"
                      type="number"
                      min={0}
                      step="0.01"
                      value={monthly}
                      onChange={(event) => setMonthly(event.target.value)}
                    />
                    <PresetPills
                      value={monthly}
                      onSelect={setMonthly}
                      options={[
                        { label: 'Aus', value: '0' },
                        { label: '10 €', value: '10' },
                        { label: '25 €', value: '25' },
                        { label: '50 €', value: '50' },
                        { label: '100 €', value: '100' },
                      ]}
                    />
                  </LlmField>

                  <LlmField label={messages.llm.retentionLabel} htmlFor="sf-llm-retention">
                    <Input
                      id="sf-llm-retention"
                      type="number"
                      min={1}
                      max={365}
                      value={retention}
                      onChange={(event) => setRetention(event.target.value)}
                    />
                    <PresetPills
                      value={retention}
                      onSelect={setRetention}
                      options={[
                        { label: '30 T', value: '30' },
                        { label: '90 T', value: '90' },
                        { label: '180 T', value: '180' },
                        { label: '365 T', value: '365' },
                      ]}
                    />
                  </LlmField>
                </div>
              </details>

              <div className="sf-foot-actions" style={{ marginTop: 16 }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <Button
                    variant="secondary"
                    onClick={handleTest}
                    disabled={
                      testing || saving || name.trim().length === 0 || baseUrl.trim().length === 0
                    }
                  >
                    {testing ? messages.llm.testing : messages.llm.testButton}
                  </Button>
                  <HelpTip text={messages.llm.testNoPrompt} />
                </div>
                <div style={{ marginLeft: 'auto' }}>
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={saving || name.trim().length === 0 || baseUrl.trim().length === 0}
                  >
                    {saving ? messages.llm.saving : messages.llm.saveProvider}
                  </Button>
                </div>
              </div>
            </form>
          </div>
        </Card>
      </div>
    </div>
  );
}

// --- Detail ----------------------------------------------------------------

export interface LlmProviderDetailPageProps {
  locale: Locale;
  messages: Messages;
  providerId: string;
}

export function LlmProviderDetailPage({
  locale,
  messages,
  providerId,
}: LlmProviderDetailPageProps) {
  const showToast = useToast();
  const [provider, setProvider] = useState<LlmProvider | null>(null);
  const [models, setModels] = useState<LlmModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [testing, setTesting] = useState(false);
  const [newModelKey, setNewModelKey] = useState('');
  const [newModelLabel, setNewModelLabel] = useState('');
  const [candidates, setCandidates] = useState<Array<{ modelKey: string }>>([]);
  const [candidateFilter, setCandidateFilter] = useState('');
  const [pendingDeleteModel, setPendingDeleteModel] = useState<LlmModel | null>(null);
  const [pendingDeleteProvider, setPendingDeleteProvider] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    if (reloadNonce === 0) setLoading(true);
    setError(null);
    Promise.all([
      api.getLlmProvider(providerId, controller.signal),
      api.listLlmModels(providerId, controller.signal),
    ])
      .then(([providerResult, modelList]) => {
        setProvider(providerResult);
        setModels(modelList);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        setError(formatApiError(err, locale));
        setLoading(false);
      });
    return () => controller.abort();
  }, [providerId, reloadNonce, locale]);

  const refresh = useCallback(() => setReloadNonce((value) => value + 1), []);

  async function handleTest(): Promise<void> {
    setTesting(true);
    setError(null);
    try {
      const result = await api.testStoredLlmProvider(providerId);
      showToast(
        result.ok
          ? messages.llm.testOk(result.latencyMs, result.models?.length ?? 0)
          : `${messages.llm.testFailed}${result.message ? ` — ${result.message}` : ''}`,
        { tone: result.ok ? 'good' : 'bad' },
      );
      refresh();
    } catch (err) {
      showToast(formatApiError(err, locale), { tone: 'bad' });
    } finally {
      setTesting(false);
    }
  }

  async function handleAddModel(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const key = newModelKey.trim();
    if (key.length === 0) return;
    setError(null);
    try {
      const input: LlmModelInput = { modelKey: key };
      if (newModelLabel.trim()) input.label = newModelLabel.trim();
      await api.createLlmModel(providerId, input);
      setNewModelKey('');
      setNewModelLabel('');
      showToast(messages.llm.saved);
      refresh();
    } catch (err) {
      showToast(formatApiError(err, locale), { tone: 'bad' });
    }
  }

  async function handleRefreshModels(): Promise<void> {
    setError(null);
    try {
      const discovered = await api.refreshLlmModels(providerId);
      setCandidates(discovered);
      showToast(messages.llm.loaded);
    } catch (err) {
      showToast(formatApiError(err, locale), { tone: 'bad' });
    }
  }

  async function handleAddCandidate(modelKey: string): Promise<void> {
    setError(null);
    try {
      await api.createLlmModel(providerId, { modelKey, source: 'discovered' });
      setCandidates((current) => current.filter((item) => item.modelKey !== modelKey));
      showToast(messages.llm.saved);
      refresh();
    } catch (err) {
      showToast(formatApiError(err, locale), { tone: 'bad' });
    }
  }

  async function toggleCapability(
    model: LlmModel,
    key: keyof LlmModel['capabilities'],
  ): Promise<void> {
    setError(null);
    try {
      await api.updateLlmModel(model.id, {
        capabilities: { ...model.capabilities, [key]: !model.capabilities[key] },
      });
      refresh();
    } catch (err) {
      showToast(formatApiError(err, locale), { tone: 'bad' });
    }
  }

  async function makeDefault(model: LlmModel): Promise<void> {
    setError(null);
    try {
      await api.updateLlmModel(model.id, { isDefault: true });
      showToast(messages.llm.saved);
      refresh();
    } catch (err) {
      showToast(formatApiError(err, locale), { tone: 'bad' });
    }
  }

  async function handleDeleteModel(): Promise<void> {
    if (!pendingDeleteModel) return;
    const target = pendingDeleteModel;
    setPendingDeleteModel(null);
    setError(null);
    try {
      await api.deleteLlmModel(target.id);
      showToast(messages.llm.saved);
      refresh();
    } catch (err) {
      showToast(formatApiError(err, locale), { tone: 'bad' });
    }
  }

  async function handleDeleteProvider(): Promise<void> {
    setPendingDeleteProvider(false);
    setError(null);
    try {
      await api.deleteLlmProvider(providerId);
      showToast(messages.llm.saved);
      navigate('/llm');
    } catch (err) {
      showToast(formatApiError(err, locale), { tone: 'bad' });
    }
  }

  if (loading) {
    return (
      <div>
        <span className="numeric">{messages.common.loadingPlatform}</span>
      </div>
    );
  }

  if (!provider) {
    return (
      <div>
        <PageHeader title={messages.llm.notFoundTitle} />
        <EmptyState
          title={messages.llm.notFoundTitle}
          description={error ?? messages.llm.notFoundDescription}
          action={
            <Button variant="secondary" onClick={() => navigate('/llm')}>
              {messages.llm.backToList}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <AppLink to="/llm" className="sf-text-link">
          ← {messages.llm.backToList}
        </AppLink>
      </div>
      <PageHeader
        title={provider.name}
        description={`${provider.baseUrl}${provider.chatPath}`}
        actions={
          <>
            <Button variant="secondary" onClick={handleTest} disabled={testing}>
              {testing ? messages.llm.testing : messages.llm.testButton}
            </Button>
            <Button variant="secondary" onClick={() => navigate(`/llm/${provider.id}/edit`)}>
              {messages.llm.editTitle}
            </Button>
            <Button variant="danger" onClick={() => setPendingDeleteProvider(true)}>
              {messages.llm.deleteProvider}
            </Button>
          </>
        }
      />

      <div className="sf-stack">
        {error ? (
          <div className="sf-alert sf-alert-bad" role="alert">
            <span>{error}</span>
          </div>
        ) : null}

        <Card>
          <div className="sf-card-body">
            <div className="sf-kv-list">
              <div className="sf-kv-row">
                <span className="label">{messages.llm.factBaseUrl}</span>
                <span>
                  <ExternalLink href={provider.baseUrl} />
                </span>
              </div>
              <div className="sf-kv-row">
                <span className="label">{messages.llm.factAuth}</span>
                <span>
                  {provider.authStyle}
                  {provider.keySet
                    ? ` · ${messages.llm.keySet(
                        provider.keyUpdatedAt
                          ? formatDateShort(provider.keyUpdatedAt, locale)
                          : '—',
                      )}`
                    : ` · ${messages.llm.keyNotSet}`}
                </span>
              </div>
              <div className="sf-kv-row">
                <span className="label">{messages.llm.factTimeout}</span>
                <span className="numeric">
                  {messages.llm.retrySummary(
                    Math.round(provider.timeoutMs / 1000),
                    provider.maxRetries,
                  )}
                </span>
              </div>
              <div className="sf-kv-row">
                <span className="label">{messages.llm.factAccess}</span>
                <span>
                  {provider.allowedPlugins === null
                    ? messages.llm.allPlugins
                    : provider.allowedPlugins.join(', ')}
                </span>
              </div>
              <div className="sf-kv-row">
                <span className="label">{messages.llm.factLastTest}</span>
                <span>
                  {provider.lastTestAt
                    ? `${formatDateTime(provider.lastTestAt, locale)} · ${
                        provider.lastTestMs ?? 0
                      } ms`
                    : messages.llm.neverTested}
                </span>
              </div>
              <div className="sf-kv-row">
                <span className="label">{messages.llm.defaultLabel}</span>
                {provider.isDefault ? (
                  <Badge tone="accent">{messages.llm.defaultLabel}</Badge>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      void api
                        .updateLlmProvider(provider.id, { isDefault: true })
                        .then(() => {
                          showToast(messages.llm.saved);
                          refresh();
                        })
                        .catch((err: unknown) => {
                          showToast(formatApiError(err, locale), { tone: 'bad' });
                        });
                    }}
                  >
                    {messages.llm.makeDefault}
                  </Button>
                )}
              </div>
              <div className="sf-kv-row">
                <span className="label">{messages.llm.statusLabel}</span>
                <Badge tone={provider.status === 'active' ? 'good' : 'neutral'}>
                  {provider.status === 'active'
                    ? messages.llm.statusActive
                    : messages.llm.statusDisabled}
                </Badge>
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader
            title={messages.llm.modelsTitle}
            meta={messages.llm.modelsMeta(models.length)}
            actions={
              <>
                <Button variant="ghost" size="sm" onClick={handleRefreshModels}>
                  {messages.llm.refreshModels}
                </Button>
              </>
            }
          />
          {models.length === 0 ? (
            <EmptyState title={messages.llm.modelsTitle} description={messages.llm.noModels} />
          ) : (
            <div className="sf-table-wrap">
              <table className="sf-table">
                <thead>
                  <tr>
                    <th scope="col" className="label">
                      {messages.llm.modelKeyLabel}
                    </th>
                    <th scope="col" className="label">
                      {messages.llm.capabilitiesLabel}
                    </th>
                    <th scope="col" className="label">
                      {messages.llm.contextLabel}
                    </th>
                    <th scope="col" className="label">
                      {messages.llm.defaultLabel}
                    </th>
                    <th scope="col" className="label sf-table-actions">
                      {messages.llm.colAction}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((model) => (
                    <tr key={model.id}>
                      <td>
                        <div className="numeric">{model.modelKey}</div>
                        <div className="sf-tenant-slug">
                          {model.label} ·{' '}
                          {model.source === 'discovered'
                            ? messages.llm.discovered
                            : messages.llm.manual}
                        </div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {(
                            [
                              ['tools', messages.llm.capTools],
                              ['json', messages.llm.capJson],
                              ['vision', messages.llm.capVision],
                              ['embeddings', messages.llm.capEmbeddings],
                            ] as const
                          ).map(([key, label]) => (
                            <button
                              key={key}
                              type="button"
                              className="sf-badge"
                              aria-pressed={model.capabilities[key]}
                              onClick={() => void toggleCapability(model, key)}
                              style={{ cursor: 'pointer' }}
                            >
                              {model.capabilities[key] ? `✓ ${label}` : `— ${label}`}
                            </button>
                          ))}
                        </div>
                      </td>
                      <td>
                        <span className="numeric">{model.contextWindow ?? '—'}</span>
                      </td>
                      <td>
                        {model.isDefault || models.length === 1 ? (
                          <Badge tone="accent">{messages.llm.defaultLabel}</Badge>
                        ) : (
                          <Button variant="ghost" size="sm" onClick={() => void makeDefault(model)}>
                            {messages.llm.makeDefault}
                          </Button>
                        )}
                      </td>
                      <td className="sf-table-actions">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setPendingDeleteModel(model)}
                        >
                          {messages.llm.deleteModel}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {candidates.length > 0
            ? (() => {
                const terms = candidateFilter
                  .trim()
                  .toLowerCase()
                  .split(/\s+/)
                  .filter(Boolean);
                const filteredCandidates =
                  terms.length === 0
                    ? candidates
                    : candidates.filter((candidate) => {
                        const haystack = candidate.modelKey.toLowerCase();
                        return terms.every((term) => haystack.includes(term));
                      });
                return (
                  <div className="sf-card-body">
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        marginBottom: 12,
                        flexWrap: 'wrap',
                      }}
                    >
                      <div style={{ flex: '1 1 260px' }}>
                        <Input
                          id="sf-llm-candidate-filter"
                          type="search"
                          aria-label={messages.llm.filterModelsPlaceholder}
                          value={candidateFilter}
                          onChange={(event) => setCandidateFilter(event.target.value)}
                          placeholder={messages.llm.filterModelsPlaceholder}
                        />
                      </div>
                      <span className="numeric sf-field-hint">
                        {messages.llm.filterModelsCount(
                          filteredCandidates.length,
                          candidates.length,
                        )}
                      </span>
                    </div>
                    {filteredCandidates.length === 0 ? (
                      <p className="sf-field-hint">{messages.llm.filterModelsEmpty}</p>
                    ) : (
                      <div
                        className="sf-kv-list"
                        style={{ maxHeight: 360, overflowY: 'auto', paddingRight: 4 }}
                      >
                        {filteredCandidates.map((candidate) => (
                          <div className="sf-kv-row" key={candidate.modelKey}>
                            <span className="numeric">{candidate.modelKey}</span>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => void handleAddCandidate(candidate.modelKey)}
                            >
                              {messages.llm.addModel}
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()
            : null}
          <div className="sf-card-body">
            <form className="sf-form-grid" onSubmit={handleAddModel}>
              <Field label={messages.llm.modelKeyLabel} htmlFor="sf-llm-model-key">
                <Input
                  id="sf-llm-model-key"
                  value={newModelKey}
                  onChange={(event) => setNewModelKey(event.target.value)}
                  placeholder="qwen3-32b"
                  maxLength={200}
                />
              </Field>
              <Field label={messages.llm.modelLabelLabel} htmlFor="sf-llm-model-label">
                <Input
                  id="sf-llm-model-label"
                  value={newModelLabel}
                  onChange={(event) => setNewModelLabel(event.target.value)}
                  placeholder="Qwen3 32B"
                  maxLength={120}
                />
              </Field>
              <Button type="submit" variant="secondary" disabled={newModelKey.trim().length === 0}>
                {messages.llm.addModel}
              </Button>
            </form>
          </div>
        </Card>
      </div>

      <ConfirmModal
        open={pendingDeleteModel !== null}
        title={messages.llm.deleteModelConfirm}
        description={pendingDeleteModel?.modelKey ?? ''}
        confirmLabel={messages.llm.deleteModel}
        cancelLabel={messages.common.cancel}
        closeLabel={messages.common.close}
        danger
        onConfirm={() => void handleDeleteModel()}
        onCancel={() => setPendingDeleteModel(null)}
      />
      <ConfirmModal
        open={pendingDeleteProvider}
        title={messages.llm.deleteProviderConfirm}
        description={provider.name}
        confirmLabel={messages.llm.deleteProvider}
        cancelLabel={messages.common.cancel}
        closeLabel={messages.common.close}
        danger
        onConfirm={() => void handleDeleteProvider()}
        onCancel={() => setPendingDeleteProvider(false)}
      />
    </div>
  );
}
