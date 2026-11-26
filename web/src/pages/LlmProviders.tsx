import { useCallback, useEffect, useState, type FormEvent } from 'react';
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
  LlmModel,
  LlmModelInput,
  LlmProvider,
  LlmProviderInput,
  LlmProviderTestResult,
  LlmPurpose,
  LlmUsageSummary,
} from '../lib/types';

const PAGE_SIZE = 25;

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

type ListTab = 'providers' | 'purposes' | 'usage';

export function LlmProvidersPage({ locale, messages }: LlmProvidersPageProps) {
  const [tab, setTab] = useState<ListTab>('providers');
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [total, setTotal] = useState(0);
  const [purposes, setPurposes] = useState<LlmPurpose[]>([]);
  const [summary, setSummary] = useState<LlmUsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [newPurpose, setNewPurpose] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    Promise.all([
      api.listLlmProviders({ limit: PAGE_SIZE }, controller.signal),
      api.listLlmPurposes(controller.signal),
      api.llmUsageSummary(30, controller.signal),
    ])
      .then(([providerPage, purposeList, usageSummary]) => {
        setProviders(providerPage.items);
        setTotal(providerPage.total);
        setPurposes(purposeList);
        setSummary(usageSummary);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        setError(formatApiError(err, locale));
        setLoading(false);
      });
    return () => controller.abort();
  }, [reloadNonce, locale]);

  const refresh = useCallback(() => setReloadNonce((value) => value + 1), []);

  async function handleAddPurpose(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const name = newPurpose.trim();
    if (name.length === 0) return;
    setError(null);
    setFeedback(null);
    try {
      await api.createLlmPurpose({ purpose: name });
      setNewPurpose('');
      setFeedback(messages.llm.saved);
      refresh();
    } catch (err) {
      setError(formatApiError(err, locale));
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
        {feedback ? (
          <div className="sf-alert sf-alert-good" role="status">
            <span>{feedback}</span>
          </div>
        ) : null}
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
                <span className="sf-tab-count">{total}</span>
              </button>
              <button
                type="button"
                aria-pressed={tab === 'purposes'}
                onClick={() => setTab('purposes')}
                className={tab === 'purposes' ? 'sf-tab sf-tab-active' : 'sf-tab'}
              >
                <span>{messages.llm.purposesTitle}</span>
                <span className="sf-tab-count">{purposes.length}</span>
              </button>
              <button
                type="button"
                aria-pressed={tab === 'usage'}
                onClick={() => setTab('usage')}
                className={tab === 'usage' ? 'sf-tab sf-tab-active' : 'sf-tab'}
              >
                <span>{messages.llm.usageTitle}</span>
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
                          <div className="numeric sf-tenant-slug">{provider.baseUrl}</div>
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
          ) : tab === 'purposes' ? (
            <div>
              <div className="sf-card-body">
                <p className="sf-card-text">{messages.llm.purposesMeta}</p>
                <form className="sf-form-grid" onSubmit={handleAddPurpose}>
                  <Field label={messages.llm.purposeLabel} htmlFor="sf-llm-purpose-name">
                    <Input
                      id="sf-llm-purpose-name"
                      value={newPurpose}
                      onChange={(event) => setNewPurpose(event.target.value)}
                      placeholder={messages.llm.purposePlaceholder}
                      maxLength={80}
                    />
                  </Field>
                  <Button
                    type="submit"
                    variant="secondary"
                    disabled={newPurpose.trim().length === 0}
                  >
                    {messages.llm.addPurpose}
                  </Button>
                </form>
              </div>
              {purposes.length === 0 ? (
                <EmptyState
                  title={messages.llm.purposesTitle}
                  description={messages.llm.purposesMeta}
                />
              ) : (
                <div className="sf-table-wrap">
                  <table className="sf-table">
                    <thead>
                      <tr>
                        <th scope="col" className="label">
                          {messages.llm.purposeLabel}
                        </th>
                        <th scope="col" className="label">
                          {messages.llm.modelLabel}
                        </th>
                        <th scope="col" className="label">
                          {messages.llm.fallbackLabel}
                        </th>
                        <th scope="col" className="label">
                          {messages.llm.callsLabel}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {purposes.map((purpose) => (
                        <tr key={purpose.purpose}>
                          <td>
                            <span className="numeric">{purpose.purpose}</span>
                          </td>
                          <td>
                            {purpose.model ? (
                              <div>
                                <div>{purpose.model.modelKey}</div>
                                <div className="numeric sf-tenant-slug">
                                  {purpose.model.providerName}
                                </div>
                              </div>
                            ) : (
                              <Badge tone="warn">{messages.llm.unmapped}</Badge>
                            )}
                          </td>
                          <td>
                            <span className="numeric">
                              {purpose.fallbackModel?.modelKey ?? '—'}
                            </span>
                          </td>
                          <td>
                            <span className="numeric">{purpose.calls30d}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : (
            <UsageTable locale={locale} messages={messages} summary={summary} />
          )}
        </Card>
      </div>
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

const PRESETS: Array<{ id: string; baseUrl: string }> = [
  { id: 'openai', baseUrl: 'https://api.openai.com/v1' },
  { id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  { id: 'vllm', baseUrl: 'http://127.0.0.1:8000/v1' },
  { id: 'litellm', baseUrl: 'http://127.0.0.1:4000/v1' },
];

export interface LlmProviderFormPageProps {
  locale: Locale;
  messages: Messages;
  providerId?: string;
}

export function LlmProviderFormPage({ locale, messages, providerId }: LlmProviderFormPageProps) {
  const editing = Boolean(providerId);
  const [name, setName] = useState('');
  const [preset, setPreset] = useState('custom');
  const [baseUrl, setBaseUrl] = useState('');
  const [chatPath, setChatPath] = useState('/chat/completions');
  const [apiVersion, setApiVersion] = useState('');
  const [authStyle, setAuthStyle] = useState<LlmAuthStyle>('bearer');
  const [authHeader, setAuthHeader] = useState('Authorization');
  const [apiKey, setApiKey] = useState('');
  const [extraHeaders, setExtraHeaders] = useState('');
  const [timeoutSeconds, setTimeoutSeconds] = useState('30');
  const [retries, setRetries] = useState('1');
  const [rate, setRate] = useState('60');
  const [daily, setDaily] = useState('0');
  const [monthly, setMonthly] = useState('0');
  const [retention, setRetention] = useState('90');
  const [allowed, setAllowed] = useState('');
  const [status, setStatus] = useState<'active' | 'disabled'>('active');
  const [keySet, setKeySet] = useState(false);
  const [loading, setLoading] = useState(editing);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<LlmProviderTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | undefined>>({});

  useEffect(() => {
    if (!providerId) return;
    const controller = new AbortController();
    api
      .getLlmProvider(providerId, controller.signal)
      .then((provider) => {
        setName(provider.name);
        setPreset(provider.preset);
        setBaseUrl(provider.baseUrl);
        setChatPath(provider.chatPath);
        setApiVersion(provider.apiVersion ?? '');
        setAuthStyle(provider.authStyle);
        setAuthHeader(provider.authHeader ?? 'Authorization');
        setKeySet(provider.keySet);
        setTimeoutSeconds(String(Math.round(provider.timeoutMs / 1000)));
        setRetries(String(provider.maxRetries));
        setRate(String(provider.rateLimitPerMinute));
        setDaily(String(provider.dailyTokenLimit));
        setMonthly(String(provider.monthlyBudgetMicros / 1_000_000));
        setRetention(String(provider.retentionDays));
        setAllowed(provider.allowedPlugins ? provider.allowedPlugins.join(', ') : '');
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

  function parsedHeaders(): Record<string, string> | undefined {
    const text = extraHeaders.trim();
    if (text.length === 0) return undefined;
    try {
      const value = JSON.parse(text) as unknown;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
      const headers: Record<string, string> = {};
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'string') headers[key] = item;
      }
      return headers;
    } catch {
      return undefined;
    }
  }

  function buildInput(): LlmProviderInput {
    const input: LlmProviderInput = {
      name: name.trim(),
      preset,
      baseUrl: baseUrl.trim(),
      chatPath: chatPath.trim(),
      authStyle,
      timeoutMs: numberOrZero(timeoutSeconds) * 1000,
      maxRetries: numberOrZero(retries),
      rateLimitPerMinute: numberOrZero(rate),
      dailyTokenLimit: numberOrZero(daily),
      monthlyBudgetMicros: Math.round(Number.parseFloat(monthly) * 1_000_000) || 0,
      retentionDays: numberOrZero(retention),
      allowedPlugins: allowed
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
      status,
    };
    if (apiVersion.trim()) input.apiVersion = apiVersion.trim();
    if (authStyle === 'header') input.authHeader = authHeader.trim();
    if (apiKey.trim()) input.apiKey = apiKey.trim();
    const headers = parsedHeaders();
    if (headers) input.extraHeaders = headers;
    return input;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});
    if (extraHeaders.trim().length > 0 && parsedHeaders() === undefined) {
      setFieldErrors({ extraHeaders: messages.llm.invalidJson });
      setError(messages.llm.invalidJson);
      setSaving(false);
      return;
    }
    try {
      const input = buildInput();
      if (providerId) {
        await api.updateLlmProvider(providerId, input);
        navigate(`/llm/${providerId}`);
      } else {
        const created = await api.createLlmProvider(input);
        navigate(`/llm/${created.id}`);
      }
    } catch (err) {
      setFieldErrors({
        name: errorField(err, 'name'),
        baseUrl: errorField(err, 'baseUrl'),
        chatPath: errorField(err, 'chatPath'),
        apiKey: errorField(err, 'apiKey'),
        extraHeaders: errorField(err, 'extraHeaders'),
        allowedPlugins: errorField(err, 'allowedPlugins'),
        authHeader: errorField(err, 'authHeader'),
      });
      setError(formatApiError(err, locale));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest(): Promise<void> {
    setTesting(true);
    setError(null);
    setTest(null);
    try {
      const input = buildInput();
      const result = providerId
        ? await api.testLlmProvider({ ...input, providerId })
        : await api.testLlmProvider(input);
      setTest(result);
    } catch (err) {
      setError(formatApiError(err, locale));
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

        <Card>
          <CardHeader title={messages.llm.newTitle} />
          <div className="sf-card-body">
            <form onSubmit={handleSubmit}>
              <div className="sf-form-grid">
                <Field
                  label={messages.llm.nameLabel}
                  error={fieldErrors.name}
                  htmlFor="sf-llm-name"
                >
                  <Input
                    id="sf-llm-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={messages.llm.namePlaceholder}
                    invalid={Boolean(fieldErrors.name)}
                    maxLength={80}
                    required
                  />
                </Field>

                <Field label={messages.llm.presetLabel} htmlFor="sf-llm-preset">
                  <select
                    id="sf-llm-preset"
                    className="sf-input"
                    value={preset}
                    onChange={(event) => {
                      const next = event.target.value;
                      setPreset(next);
                      const candidate = PRESETS.find((item) => item.id === next);
                      if (candidate) setBaseUrl(candidate.baseUrl);
                    }}
                  >
                    <option value="custom">{messages.llm.presetCustom}</option>
                    {PRESETS.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.id}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field
                  label={messages.llm.baseUrlLabel}
                  hint={messages.llm.baseUrlHint}
                  error={fieldErrors.baseUrl}
                  htmlFor="sf-llm-base-url"
                >
                  <Input
                    id="sf-llm-base-url"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder="https://llm.example/v1"
                    invalid={Boolean(fieldErrors.baseUrl)}
                    maxLength={500}
                    required
                  />
                </Field>

                <Field
                  label={messages.llm.chatPathLabel}
                  hint={messages.llm.chatPathHint}
                  error={fieldErrors.chatPath}
                  htmlFor="sf-llm-chat-path"
                >
                  <Input
                    id="sf-llm-chat-path"
                    value={chatPath}
                    onChange={(event) => setChatPath(event.target.value)}
                    maxLength={200}
                  />
                </Field>

                <Field label={messages.llm.apiVersionLabel} htmlFor="sf-llm-api-version">
                  <Input
                    id="sf-llm-api-version"
                    value={apiVersion}
                    onChange={(event) => setApiVersion(event.target.value)}
                    placeholder="2024-10-21"
                    maxLength={50}
                  />
                </Field>

                <Field label={messages.llm.authStyleLabel} htmlFor="sf-llm-auth-style">
                  <select
                    id="sf-llm-auth-style"
                    className="sf-input"
                    value={authStyle}
                    onChange={(event) => setAuthStyle(event.target.value as LlmAuthStyle)}
                  >
                    <option value="bearer">{messages.llm.authBearer}</option>
                    <option value="header">{messages.llm.authHeader}</option>
                    <option value="none">{messages.llm.authNone}</option>
                  </select>
                </Field>

                {authStyle === 'header' ? (
                  <Field
                    label={messages.llm.authHeaderLabel}
                    error={fieldErrors.authHeader}
                    htmlFor="sf-llm-auth-header"
                  >
                    <Input
                      id="sf-llm-auth-header"
                      value={authHeader}
                      onChange={(event) => setAuthHeader(event.target.value)}
                      placeholder="api-key"
                      invalid={Boolean(fieldErrors.authHeader)}
                    />
                  </Field>
                ) : null}

                {authStyle !== 'none' ? (
                  <Field
                    label={messages.llm.apiKeyLabel}
                    hint={keySet ? messages.llm.apiKeyKeep : messages.llm.apiKeyHint}
                    error={fieldErrors.apiKey}
                    htmlFor="sf-llm-api-key"
                  >
                    <Input
                      id="sf-llm-api-key"
                      type="password"
                      autoComplete="off"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder={keySet ? '••••••••' : 'sk-…'}
                      invalid={Boolean(fieldErrors.apiKey)}
                    />
                  </Field>
                ) : null}

                <Field label={messages.llm.timeoutLabel} htmlFor="sf-llm-timeout">
                  <Input
                    id="sf-llm-timeout"
                    type="number"
                    min={1}
                    max={60}
                    value={timeoutSeconds}
                    onChange={(event) => setTimeoutSeconds(event.target.value)}
                  />
                </Field>

                <Field label={messages.llm.retriesLabel} htmlFor="sf-llm-retries">
                  <Input
                    id="sf-llm-retries"
                    type="number"
                    min={0}
                    max={3}
                    value={retries}
                    onChange={(event) => setRetries(event.target.value)}
                  />
                </Field>

                <Field label={messages.llm.rateLabel} htmlFor="sf-llm-rate">
                  <Input
                    id="sf-llm-rate"
                    type="number"
                    min={1}
                    max={600}
                    value={rate}
                    onChange={(event) => setRate(event.target.value)}
                  />
                </Field>

                <Field label={messages.llm.dailyLabel} htmlFor="sf-llm-daily">
                  <Input
                    id="sf-llm-daily"
                    type="number"
                    min={0}
                    value={daily}
                    onChange={(event) => setDaily(event.target.value)}
                  />
                </Field>

                <Field label={messages.llm.monthlyLabel} htmlFor="sf-llm-monthly">
                  <Input
                    id="sf-llm-monthly"
                    type="number"
                    min={0}
                    step="0.01"
                    value={monthly}
                    onChange={(event) => setMonthly(event.target.value)}
                  />
                </Field>

                <Field label={messages.llm.retentionLabel} htmlFor="sf-llm-retention">
                  <Input
                    id="sf-llm-retention"
                    type="number"
                    min={1}
                    max={365}
                    value={retention}
                    onChange={(event) => setRetention(event.target.value)}
                  />
                </Field>

                <Field
                  label={messages.llm.allowedLabel}
                  hint={messages.llm.allowedHint}
                  error={fieldErrors.allowedPlugins}
                  htmlFor="sf-llm-allowed"
                >
                  <Input
                    id="sf-llm-allowed"
                    value={allowed}
                    onChange={(event) => setAllowed(event.target.value)}
                    placeholder="agent, email"
                    invalid={Boolean(fieldErrors.allowedPlugins)}
                  />
                </Field>

                {editing ? (
                  <Field label={messages.llm.statusLabel} htmlFor="sf-llm-status">
                    <select
                      id="sf-llm-status"
                      className="sf-input"
                      value={status}
                      onChange={(event) =>
                        setStatus(event.target.value === 'disabled' ? 'disabled' : 'active')
                      }
                    >
                      <option value="active">{messages.llm.statusActive}</option>
                      <option value="disabled">{messages.llm.statusDisabled}</option>
                    </select>
                  </Field>
                ) : null}
              </div>

              <div className="sf-form-grid" style={{ marginTop: 12 }}>
                <Field
                  label={messages.llm.extraHeadersLabel}
                  hint={messages.llm.extraHeadersHint}
                  error={fieldErrors.extraHeaders}
                  htmlFor="sf-llm-extra-headers"
                >
                  <textarea
                    id="sf-llm-extra-headers"
                    className="sf-input"
                    rows={3}
                    value={extraHeaders}
                    onChange={(event) => setExtraHeaders(event.target.value)}
                    placeholder='{"X-Organization": "smartflow"}'
                    aria-invalid={Boolean(fieldErrors.extraHeaders) || undefined}
                  />
                </Field>
              </div>

              {test ? (
                <div
                  className={test.ok ? 'sf-alert sf-alert-good' : 'sf-alert sf-alert-bad'}
                  role="status"
                  style={{ marginTop: 12 }}
                >
                  <span>
                    {test.ok
                      ? messages.llm.testOk(test.latencyMs, test.models?.length ?? 0)
                      : messages.llm.testFailed}
                  </span>
                </div>
              ) : null}

              <div className="sf-foot-actions" style={{ marginTop: 12 }}>
                <Button variant="secondary" onClick={handleTest} disabled={testing || saving}>
                  {testing ? messages.llm.testing : messages.llm.testButton}
                </Button>
                <span className="numeric sf-field-hint">{messages.llm.testNoPrompt}</span>
                <div style={{ marginLeft: 'auto' }}>
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={saving || name.trim().length === 0}
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
  const [provider, setProvider] = useState<LlmProvider | null>(null);
  const [models, setModels] = useState<LlmModel[]>([]);
  const [purposes, setPurposes] = useState<LlmPurpose[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [testing, setTesting] = useState(false);
  const [newModelKey, setNewModelKey] = useState('');
  const [newModelLabel, setNewModelLabel] = useState('');
  const [candidates, setCandidates] = useState<Array<{ modelKey: string }>>([]);
  const [pendingDeleteModel, setPendingDeleteModel] = useState<LlmModel | null>(null);
  const [pendingDeleteProvider, setPendingDeleteProvider] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    Promise.all([
      api.getLlmProvider(providerId, controller.signal),
      api.listLlmModels(providerId, controller.signal),
      api.listLlmPurposes(controller.signal),
    ])
      .then(([providerResult, modelList, purposeList]) => {
        setProvider(providerResult);
        setModels(modelList);
        setPurposes(purposeList);
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
    setFeedback(null);
    try {
      const result = await api.testStoredLlmProvider(providerId);
      setFeedback(
        result.ok
          ? messages.llm.testOk(result.latencyMs, result.models?.length ?? 0)
          : `${messages.llm.testFailed}${result.message ? ` — ${result.message}` : ''}`,
      );
      refresh();
    } catch (err) {
      setError(formatApiError(err, locale));
    } finally {
      setTesting(false);
    }
  }

  async function handleAddModel(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const key = newModelKey.trim();
    if (key.length === 0) return;
    setError(null);
    setFeedback(null);
    try {
      const input: LlmModelInput = { modelKey: key };
      if (newModelLabel.trim()) input.label = newModelLabel.trim();
      await api.createLlmModel(providerId, input);
      setNewModelKey('');
      setNewModelLabel('');
      setFeedback(messages.llm.saved);
      refresh();
    } catch (err) {
      setError(formatApiError(err, locale));
    }
  }

  async function handleRefreshModels(): Promise<void> {
    setError(null);
    setFeedback(null);
    try {
      const discovered = await api.refreshLlmModels(providerId);
      setCandidates(discovered);
      setFeedback(messages.llm.loaded);
    } catch (err) {
      setError(formatApiError(err, locale));
    }
  }

  async function handleAddCandidate(modelKey: string): Promise<void> {
    setError(null);
    try {
      await api.createLlmModel(providerId, { modelKey, source: 'discovered' });
      setCandidates((current) => current.filter((item) => item.modelKey !== modelKey));
      refresh();
    } catch (err) {
      setError(formatApiError(err, locale));
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
      setError(formatApiError(err, locale));
    }
  }

  async function makeDefault(model: LlmModel): Promise<void> {
    setError(null);
    try {
      await api.updateLlmModel(model.id, { isDefault: true });
      refresh();
    } catch (err) {
      setError(formatApiError(err, locale));
    }
  }

  async function assign(purpose: LlmPurpose, modelId: string): Promise<void> {
    setError(null);
    setFeedback(null);
    try {
      await api.updateLlmPurpose(purpose.purpose, { modelId: modelId === '' ? null : modelId });
      setFeedback(messages.llm.saved);
      refresh();
    } catch (err) {
      setError(formatApiError(err, locale));
    }
  }

  async function handleDeleteModel(): Promise<void> {
    if (!pendingDeleteModel) return;
    const target = pendingDeleteModel;
    setPendingDeleteModel(null);
    setError(null);
    try {
      await api.deleteLlmModel(target.id);
      setFeedback(messages.llm.saved);
      refresh();
    } catch (err) {
      setError(formatApiError(err, locale));
    }
  }

  async function handleDeleteProvider(): Promise<void> {
    setPendingDeleteProvider(false);
    setError(null);
    try {
      await api.deleteLlmProvider(providerId);
      navigate('/llm');
    } catch (err) {
      setError(formatApiError(err, locale));
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
        {feedback ? (
          <div className="sf-alert sf-alert-good" role="status">
            <span>{feedback}</span>
          </div>
        ) : null}
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
                <span className="numeric">{provider.baseUrl}</span>
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
                        {model.isDefault ? (
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
          {candidates.length > 0 ? (
            <div className="sf-card-body">
              <div className="sf-kv-list">
                {candidates.map((candidate) => (
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
            </div>
          ) : null}
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

        <Card>
          <CardHeader
            title={messages.llm.purposesTitle}
            meta={messages.llm.purposesMeta}
            actions={
              <AppLink to="/llm" className="sf-text-link">
                {messages.llm.purposesTitle}
              </AppLink>
            }
          />
          <div className="sf-card-body">
            <div className="sf-kv-list">
              {purposes.map((purpose) => {
                const assigned = purpose.model?.providerId === provider.id;
                return (
                  <div className="sf-kv-row" key={purpose.purpose}>
                    <span className="numeric">{purpose.purpose}</span>
                    <select
                      className="sf-input"
                      aria-label={`${purpose.purpose} ${messages.llm.modelLabel}`}
                      value={assigned ? (purpose.model?.id ?? '') : ''}
                      onChange={(event) => void assign(purpose, event.target.value)}
                      style={{ maxWidth: 280 }}
                    >
                      <option value="">{messages.llm.unmapped}</option>
                      {models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.modelKey}
                        </option>
                      ))}
                    </select>
                    <Badge tone={assigned ? 'good' : 'warn'}>
                      {assigned ? (purpose.model?.modelKey ?? '—') : messages.llm.unmapped}
                    </Badge>
                  </div>
                );
              })}
            </div>
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
