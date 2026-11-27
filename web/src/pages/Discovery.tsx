import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { HelpTip } from '../components/HelpTip';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmModal,
  EmptyState,
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
import { navigate } from '../lib/router';
import type {
  DiscoveryInvite,
  DiscoveryInviteCreated,
  DiscoveryInviteDetail,
  DiscoveryInviteListResponse,
  DiscoveryInviteStatus,
  DiscoveryLocale,
  DiscoveryMode,
  DiscoveryOverview,
  DiscoveryReport,
} from '../lib/types';
import { ReportView } from './DiscoveryPublic';

const PAGE_SIZE = 10;

export interface DiscoveryPageProps {
  inviteId: string | null;
  search: string;
  locale: Locale;
  messages: Messages;
}

function statusTone(status: DiscoveryInviteStatus): 'neutral' | 'good' | 'warn' | 'bad' | 'accent' {
  switch (status) {
    case 'completed':
      return 'good';
    case 'in_progress':
      return 'accent';
    case 'open':
      return 'neutral';
    case 'revoked':
      return 'bad';
    case 'expired':
      return 'warn';
    default:
      return 'neutral';
  }
}

function statusLabel(m: Messages, status: DiscoveryInviteStatus): string {
  switch (status) {
    case 'open':
      return m.discovery.statusOpen;
    case 'in_progress':
      return m.discovery.statusInProgress;
    case 'completed':
      return m.discovery.statusCompleted;
    case 'revoked':
      return m.discovery.statusRevoked;
    case 'expired':
      return m.discovery.statusExpired;
    default:
      return status;
  }
}

function DiscoveryField({
  label,
  hint,
  error,
  htmlFor,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  htmlFor?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`sf-field${wide ? ' sf-form-span' : ''}`}>
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

export function DiscoveryPage({ inviteId, search, locale, messages }: DiscoveryPageProps) {
  if (inviteId) {
    return <DiscoveryDetail inviteId={inviteId} locale={locale} messages={messages} />;
  }
  return <DiscoveryList search={search} locale={locale} messages={messages} />;
}

function DiscoveryList({ search, locale, messages }: Omit<DiscoveryPageProps, 'inviteId'>) {
  const [overview, setOverview] = useState<DiscoveryOverview | null>(null);
  const [list, setList] = useState<DiscoveryInviteListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | DiscoveryInviteStatus>('all');
  const [query, setQuery] = useState(() => new URLSearchParams(search).get('q') ?? '');
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [reloadNonce, setReloadNonce] = useState(0);

  const [customerName, setCustomerName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [inviteLocale, setInviteLocale] = useState<DiscoveryLocale>('de');
  const [mode, setMode] = useState<DiscoveryMode>('standard');
  const [expiresInDays, setExpiresInDays] = useState(14);
  const [tenantId, setTenantId] = useState('');
  const [tenants, setTenants] = useState<Array<{ id: string; name: string }>>([]);
  const [creating, setCreating] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<DiscoveryInviteCreated | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<DiscoveryInvite | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const showToast = useToast();

  const currentCursor = cursorStack[cursorStack.length - 1] ?? null;
  const m = messages;

  const refresh = useCallback(() => setReloadNonce((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    Promise.all([
      api.listDiscoveryInvites(
        {
          status: statusFilter === 'all' ? undefined : statusFilter,
          q: query,
          limit: PAGE_SIZE,
          cursor: currentCursor,
        },
        controller.signal,
      ),
      api.discoveryOverview(controller.signal),
    ])
      .then(([page, summary]) => {
        setList(page);
        setOverview(summary);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        setError(formatApiError(err, locale));
        setLoading(false);
      });
    return () => controller.abort();
  }, [statusFilter, query, currentCursor, reloadNonce, locale]);

  useEffect(() => {
    const controller = new AbortController();
    api
      .listTenants({ limit: 100 }, controller.signal)
      .then((response) =>
        setTenants(response.items.map((tenant) => ({ id: tenant.id, name: tenant.name }))),
      )
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFieldErrors({});
    setError(null);
    setCreating(true);
    try {
      const result = await api.createDiscoveryInvite({
        ...(tenantId
          ? { tenantId }
          : {
              customerName: customerName.trim(),
              ...(contactEmail.trim() ? { contactEmail: contactEmail.trim() } : {}),
            }),
        locale: inviteLocale,
        mode,
        expiresInDays,
      });
      setCreated(result);
      setCustomerName('');
      setContactEmail('');
      setTenantId('');
      setCursorStack([]);
      refresh();
      showToast(m.discovery.createTitle, { tone: 'good' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        setFieldErrors(err.fields);
      } else {
        setError(formatApiError(err, locale));
      }
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(): Promise<void> {
    if (!pendingRevoke) return;
    setBusyId(pendingRevoke.id);
    try {
      await api.revokeDiscoveryInvite(pendingRevoke.id);
      showToast(m.discovery.revokedToast, { tone: 'good' });
      setPendingRevoke(null);
      refresh();
    } catch (err) {
      setError(formatApiError(err, locale));
    } finally {
      setBusyId(null);
    }
  }

  async function handleResend(invite: DiscoveryInvite): Promise<void> {
    setBusyId(invite.id);
    try {
      const result = await api.resendDiscoveryInvite(invite.id);
      setCreated(result);
      showToast(m.discovery.linkRotatedToast, { tone: 'good' });
      refresh();
    } catch (err) {
      setError(formatApiError(err, locale));
    } finally {
      setBusyId(null);
    }
  }

  const counts = overview?.counts;
  const selectedTenant = tenants.find((tenant) => tenant.id === tenantId) ?? null;
  const start = cursorStack.length * PAGE_SIZE + 1;
  const shown = list?.items.length ?? 0;

  return (
    <>
      <PageHeader title={m.discovery.title} description={m.discovery.description} />

      <div className="sf-kpi-grid">
        <KpiTile
          label={m.discovery.kpiTotal}
          value={
            counts
              ? String(
                  counts.open +
                    counts.in_progress +
                    counts.completed +
                    counts.revoked +
                    counts.expired,
                )
              : '—'
          }
        />
        <KpiTile label={m.discovery.kpiOpen} value={counts ? String(counts.open) : '—'} />
        <KpiTile
          label={m.discovery.kpiInProgress}
          value={counts ? String(counts.in_progress) : '—'}
        />
        <KpiTile label={m.discovery.kpiCompleted} value={counts ? String(counts.completed) : '—'} />
      </div>

      <Card>
        <CardHeader title={m.discovery.createTitle} meta={m.discovery.linkNote} />
        <div className="sf-card-body sf-stack">
          <form onSubmit={(event) => void handleCreate(event)}>
            <div className="sf-form-grid-2">
              <DiscoveryField
                label={m.discovery.tenantLabel}
                hint={m.discovery.tenantHint}
                htmlFor="discovery-tenant"
                error={fieldErrors.tenantId}
                wide
              >
                <select
                  id="discovery-tenant"
                  className="sf-input"
                  value={tenantId}
                  onChange={(event) => setTenantId(event.target.value)}
                >
                  <option value="">{m.discovery.tenantNone}</option>
                  {tenants.map((tenant) => (
                    <option key={tenant.id} value={tenant.id}>
                      {tenant.name}
                    </option>
                  ))}
                </select>
                {selectedTenant ? (
                  <p className="sf-field-hint">{m.discovery.customerFromTenant}</p>
                ) : null}
              </DiscoveryField>
              {selectedTenant ? null : (
                <>
                  <DiscoveryField
                    label={m.discovery.customerLabel}
                    hint={m.discovery.customerHint}
                    htmlFor="discovery-customer"
                    error={fieldErrors.customerName}
                  >
                    <Input
                      id="discovery-customer"
                      value={customerName}
                      maxLength={120}
                      onChange={(event) => setCustomerName(event.target.value)}
                      placeholder={m.discovery.customerPlaceholder}
                      invalid={Boolean(fieldErrors.customerName)}
                    />
                  </DiscoveryField>
                  <DiscoveryField
                    label={m.discovery.emailLabel}
                    hint={m.discovery.emailHint}
                    htmlFor="discovery-email"
                    error={fieldErrors.contactEmail}
                  >
                    <Input
                      id="discovery-email"
                      type="email"
                      value={contactEmail}
                      onChange={(event) => setContactEmail(event.target.value)}
                      placeholder={m.discovery.emailPlaceholder}
                      invalid={Boolean(fieldErrors.contactEmail)}
                    />
                  </DiscoveryField>
                </>
              )}
              <DiscoveryField
                label={m.discovery.localeLabel}
                hint={m.discovery.localeHint}
                htmlFor="discovery-locale"
              >
                <select
                  id="discovery-locale"
                  className="sf-input"
                  value={inviteLocale}
                  onChange={(event) => setInviteLocale(event.target.value === 'en' ? 'en' : 'de')}
                >
                  <option value="de">Deutsch</option>
                  <option value="en">English</option>
                </select>
              </DiscoveryField>
              <DiscoveryField
                label={m.discovery.modeLabel}
                hint={m.discovery.modeHint}
                htmlFor="discovery-mode"
              >
                <select
                  id="discovery-mode"
                  className="sf-input"
                  value={mode}
                  onChange={(event) => setMode(event.target.value as DiscoveryMode)}
                >
                  <option value="short">{m.discovery.modeShort}</option>
                  <option value="standard">{m.discovery.modeStandard}</option>
                  <option value="full">{m.discovery.modeFull}</option>
                </select>
              </DiscoveryField>
              <DiscoveryField
                label={m.discovery.expiryLabel}
                hint={m.discovery.expiryHint}
                htmlFor="discovery-expiry"
                error={fieldErrors.expiresInDays}
              >
                <Input
                  id="discovery-expiry"
                  type="number"
                  min={1}
                  max={30}
                  value={expiresInDays}
                  onChange={(event) =>
                    setExpiresInDays(Number.parseInt(event.target.value, 10) || 14)
                  }
                  invalid={Boolean(fieldErrors.expiresInDays)}
                />
              </DiscoveryField>
            </div>

            <div className="sf-foot-actions sf-form-foot">
              <Button
                type="submit"
                variant="primary"
                disabled={creating || (!tenantId && customerName.trim().length < 2)}
              >
                {creating ? m.discovery.creating : m.discovery.createSubmit}
              </Button>
            </div>
          </form>

          {created ? (
            <LinkPanel
              created={created}
              m={m}
              onCopied={() => showToast(m.discovery.linkCopied, { tone: 'good' })}
            />
          ) : null}
          {error ? (
            <p className="sf-alert sf-alert-bad" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader
          title={m.discovery.listTitle}
          meta={list ? m.discovery.listSummary(shown, list.total) : undefined}
        />
        <div className="sf-card-body sf-stack">
          <div className="sf-toolbar">
            <div className="sf-tabs" role="tablist" aria-label={m.discovery.filterAll}>
              {(['all', 'open', 'in_progress', 'completed', 'revoked', 'expired'] as const).map(
                (entry) => (
                  <button
                    key={entry}
                    type="button"
                    role="tab"
                    aria-selected={statusFilter === entry}
                    className={`sf-tab${statusFilter === entry ? ' sf-tab-active' : ''}`}
                    onClick={() => {
                      setStatusFilter(entry);
                      setCursorStack([]);
                    }}
                  >
                    {entry === 'all' ? m.discovery.filterAll : statusLabel(m, entry)}
                  </button>
                ),
              )}
            </div>
            <div className="sf-search-wrap">
              <Input
                aria-label={m.discovery.searchLabel}
                placeholder={m.discovery.searchPlaceholder}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setCursorStack([]);
                }}
              />
            </div>
          </div>

          {loading && !list ? <p role="status">{m.common.loadingPlatform}</p> : null}
          {error && !list ? (
            <p className="sf-alert sf-alert-bad" role="alert">
              {error}
            </p>
          ) : null}

          {list && list.items.length === 0 ? (
            <EmptyState
              title={m.discovery.emptyTitle}
              description={m.discovery.emptyDescription}
              action={
                <Button variant="secondary" onClick={() => setStatusFilter('all')}>
                  {m.discovery.filterAll}
                </Button>
              }
            />
          ) : null}

          {list && list.items.length > 0 ? (
            <div className="sf-table-wrap">
              <table className="sf-table">
                <thead>
                  <tr>
                    <th scope="col">{m.discovery.colCustomer}</th>
                    <th scope="col">{m.discovery.colStatus}</th>
                    <th scope="col">{m.discovery.colProgress}</th>
                    <th scope="col">{m.discovery.colExpires}</th>
                    <th scope="col">{m.discovery.colActions}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.items.map((invite) => (
                    <tr key={invite.id}>
                      <td>
                        <div className="sf-tenant-name">{invite.customerName}</div>
                        <div className="sf-tenant-slug">
                          {invite.contactEmail ?? formatDateShort(invite.createdAt, locale)}
                        </div>
                      </td>
                      <td>
                        <Badge tone={statusTone(invite.status)}>
                          {statusLabel(m, invite.status)}
                        </Badge>
                      </td>
                      <td>{invite.session ? `${invite.session.progress}%` : '—'}</td>
                      <td>{formatDateShort(invite.expiresAt, locale)}</td>
                      <td>
                        <div className="sf-table-actions">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => navigate(`/discovery/${invite.id}`)}
                          >
                            {m.discovery.actionOpen}
                          </Button>
                          {invite.status !== 'completed' && invite.status !== 'revoked' ? (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busyId === invite.id}
                                onClick={() => void handleResend(invite)}
                              >
                                {m.discovery.actionResend}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busyId === invite.id}
                                onClick={() => setPendingRevoke(invite)}
                              >
                                {m.discovery.actionRevoke}
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {list ? (
            <div className="sf-pagination">
              <span className="sf-card-meta">
                {m.discovery.pageStatus(start, start + shown - 1, list.total)}
              </span>
              <div className="sf-pagination-buttons">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={cursorStack.length === 0}
                  onClick={() => setCursorStack((stack) => stack.slice(0, -1))}
                >
                  {m.discovery.prevPage}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!list.nextCursor}
                  onClick={() => setCursorStack((stack) => [...stack, list.nextCursor ?? ''])}
                >
                  {m.discovery.nextPage}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </Card>

      <ConfirmModal
        open={pendingRevoke !== null}
        title={m.discovery.revokeConfirmTitle}
        description={m.discovery.revokeConfirmBody}
        confirmLabel={m.discovery.revokeButton}
        cancelLabel={m.common.cancel}
        closeLabel={m.common.close}
        danger
        busy={busyId !== null}
        onConfirm={() => void handleRevoke()}
        onCancel={() => setPendingRevoke(null)}
      />
    </>
  );
}

function LinkPanel({
  created,
  m,
  onCopied,
}: {
  created: DiscoveryInviteCreated;
  m: Messages;
  onCopied: () => void;
}) {
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(created.link);
      onCopied();
    } catch {
      /* Clipboard denied: the link stays selectable. */
    }
  }

  return (
    <div className="sf-alert sf-alert-info sf-stack" role="status">
      <strong>{m.discovery.linkTitle}</strong>
      <code style={{ wordBreak: 'break-all' }}>{created.link}</code>
      <p className="sf-card-meta">{m.discovery.mailUnavailable}</p>
      <div>
        <Button variant="secondary" size="sm" onClick={() => void copy()}>
          {m.discovery.linkCopy}
        </Button>
      </div>
    </div>
  );
}

function DiscoveryDetail({
  inviteId,
  locale,
  messages,
}: {
  inviteId: string;
  locale: Locale;
  messages: Messages;
}) {
  const [detail, setDetail] = useState<DiscoveryInviteDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<DiscoveryInviteCreated | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState(false);
  const showToast = useToast();
  const m = messages;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setDetail(await api.getDiscoveryInvite(inviteId, signal));
      } catch (err) {
        if (isAbortError(err)) return;
        setError(formatApiError(err, locale));
      }
    },
    [inviteId, locale],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function handleRevoke(): Promise<void> {
    setBusy(true);
    try {
      await api.revokeDiscoveryInvite(inviteId);
      setPendingRevoke(false);
      showToast(m.discovery.revokedToast, { tone: 'good' });
      await load();
    } catch (err) {
      setError(formatApiError(err, locale));
    } finally {
      setBusy(false);
    }
  }

  async function handleResend(): Promise<void> {
    setBusy(true);
    try {
      setCreated(await api.resendDiscoveryInvite(inviteId));
      showToast(m.discovery.linkRotatedToast, { tone: 'good' });
      await load();
    } catch (err) {
      setError(formatApiError(err, locale));
    } finally {
      setBusy(false);
    }
  }

  if (!detail) {
    return (
      <>
        <PageHeader
          title={m.discovery.detailTitle}
          actions={
            <Button variant="secondary" onClick={() => navigate('/discovery')}>
              {m.discovery.back}
            </Button>
          }
        />
        {error ? (
          <p className="sf-alert sf-alert-bad" role="alert">
            {error}
          </p>
        ) : (
          <p role="status">{m.common.loadingPlatform}</p>
        )}
      </>
    );
  }

  const invite = detail.invite;
  const report: DiscoveryReport | null = detail.report;

  return (
    <>
      <PageHeader
        title={invite.customerName}
        description={`${invite.contactEmail ?? '—'} · ${m.discovery.modeLabel}: ${
          invite.mode === 'short'
            ? m.discovery.modeShort
            : invite.mode === 'full'
              ? m.discovery.modeFull
              : m.discovery.modeStandard
        }`}
        actions={
          <>
            <Button variant="secondary" onClick={() => navigate('/discovery')}>
              {m.discovery.back}
            </Button>
            {invite.status !== 'completed' && invite.status !== 'revoked' ? (
              <>
                <Button variant="secondary" disabled={busy} onClick={() => void handleResend()}>
                  {m.discovery.actionResend}
                </Button>
                <Button variant="danger" disabled={busy} onClick={() => setPendingRevoke(true)}>
                  {m.discovery.actionRevoke}
                </Button>
              </>
            ) : null}
          </>
        }
      />

      {error ? (
        <p className="sf-alert sf-alert-bad" role="alert">
          {error}
        </p>
      ) : null}

      {created ? (
        <LinkPanel
          created={created}
          m={m}
          onCopied={() => showToast(m.discovery.linkCopied, { tone: 'good' })}
        />
      ) : null}

      <Card>
        <CardHeader title={m.discovery.detailTitle} />
        <div className="sf-card-body">
          <dl className="sf-kv-list">
            <div className="sf-kv-row">
              <dt>{m.discovery.colStatus}</dt>
              <dd>
                <Badge tone={statusTone(invite.status)}>{statusLabel(m, invite.status)}</Badge>
              </dd>
            </div>
            <div className="sf-kv-row">
              <dt>{m.discovery.colProgress}</dt>
              <dd>{invite.session ? `${invite.session.progress}%` : '—'}</dd>
            </div>
            <div className="sf-kv-row">
              <dt>{m.discovery.colExpires}</dt>
              <dd>{formatDateTime(invite.expiresAt, locale)}</dd>
            </div>
            <div className="sf-kv-row">
              <dt>{m.discovery.contactLabel}</dt>
              <dd>{invite.contactEmail ?? '—'}</dd>
            </div>
          </dl>
        </div>
      </Card>

      <Card>
        <CardHeader title={m.discovery.answersTitle} />
        <div className="sf-card-body">
          {detail.answers.length === 0 ? (
            <p className="sf-card-meta">{m.discovery.noAnswers}</p>
          ) : (
            <dl className="sf-kv-list">
              {detail.answers.map((answer) => (
                <div key={answer.key} className="sf-kv-row">
                  <dt>{answer.label ?? answer.key}</dt>
                  <dd style={{ whiteSpace: 'pre-wrap' }}>
                    {typeof answer.value === 'string'
                      ? answer.value
                      : Array.isArray(answer.value)
                        ? answer.value.join(', ')
                        : JSON.stringify(answer.value)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title={m.discovery.reportTitle} />
        <div className="sf-card-body">
          {report ? (
            <ReportView report={report} m={m} />
          ) : (
            <p className="sf-card-meta">{m.discovery.reportUnavailable}</p>
          )}
        </div>
      </Card>

      <ConfirmModal
        open={pendingRevoke}
        title={m.discovery.revokeConfirmTitle}
        description={m.discovery.revokeConfirmBody}
        confirmLabel={m.discovery.revokeButton}
        cancelLabel={m.common.cancel}
        closeLabel={m.common.close}
        danger
        busy={busy}
        onConfirm={() => void handleRevoke()}
        onCancel={() => setPendingRevoke(false)}
      />
    </>
  );
}
