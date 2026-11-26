import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { PlusIcon } from '../components/icons';
import {
  Badge,
  Button,
  Card,
  CardHeader,
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
  formatFieldError,
  type Locale,
  type Messages,
} from '../lib/i18n';
import { siteStatusTone } from '../lib/websites';
import { navigate } from '../lib/router';
import type { WebsiteClient, WebsiteListResponse, WebsiteSummary } from '../lib/types';

const PAGE_SIZE = 10;

type OwnerFilter = 'all' | 'own' | 'client';

export interface WebsitesPageProps {
  search: string;
  locale: Locale;
  messages: Messages;
}

export function WebsitesPage({ search, locale, messages }: WebsitesPageProps) {
  const [filter, setFilter] = useState<OwnerFilter>('all');
  const [query, setQuery] = useState('');
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [list, setList] = useState<WebsiteListResponse | null>(null);
  const [summary, setSummary] = useState<WebsiteSummary | null>(null);
  const [clients, setClients] = useState<WebsiteClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [clientId, setClientId] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; domain?: string }>({});
  const [creating, setCreating] = useState(false);

  const currentCursor = cursorStack[cursorStack.length - 1] ?? null;
  const showCreate = useMemo(() => new URLSearchParams(search).get('create') === '1', [search]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .listWebsites(
        {
          owner: filter === 'all' ? undefined : filter,
          q: query,
          limit: PAGE_SIZE,
          cursor: currentCursor,
        },
        controller.signal,
      )
      .then((result) => {
        setList(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        setError(formatApiError(err, locale));
        setLoading(false);
      });
    return () => controller.abort();
  }, [filter, query, currentCursor, locale]);

  useEffect(() => {
    const controller = new AbortController();
    api
      .websiteSummary(controller.signal)
      .then((result) => setSummary(result))
      .catch(() => undefined);
    return () => controller.abort();
  }, [list]);

  useEffect(() => {
    const controller = new AbortController();
    api
      .websiteClients(undefined, controller.signal)
      .then((result) => setClients(result))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const refresh = useCallback(() => {
    setCursorStack([]);
    setList(null);
    setLoading(true);
    api
      .listWebsites({ owner: filter === 'all' ? undefined : filter, q: query, limit: PAGE_SIZE })
      .then((result) => {
        setList(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        setError(formatApiError(err, locale));
        setLoading(false);
      });
    api
      .websiteSummary()
      .then((result) => setSummary(result))
      .catch(() => undefined);
  }, [filter, query, locale]);

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFieldErrors({});
    setError(null);
    setFeedback(null);
    setCreating(true);
    try {
      const created = await api.createWebsite({
        name: name.trim(),
        ...(domain.trim().length > 0 ? { domain: domain.trim() } : {}),
        ...(clientId.length > 0 ? { client_id: clientId } : {}),
      });
      setName('');
      setDomain('');
      setClientId('');
      setFeedback(messages.websites.created(created.name));
      refresh();
      navigate(`/websites/${created.id}`);
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length > 0) {
        setFieldErrors({
          name: formatFieldError('name', err.fields.name, locale),
          domain: formatFieldError('domain', err.fields.domain, locale),
        });
        setError(messages.websites.formInvalid);
      } else {
        setError(formatApiError(err, locale));
      }
    } finally {
      setCreating(false);
    }
  }

  const items = list?.items ?? [];
  const total = list?.total ?? 0;
  const hasFilters = filter !== 'all' || query.trim().length > 0;
  const startIndex = items.length === 0 ? 0 : cursorStack.length * PAGE_SIZE + 1;
  const endIndex = cursorStack.length * PAGE_SIZE + items.length;

  return (
    <div>
      <PageHeader
        title={messages.websites.title}
        description={messages.websites.description}
        actions={
          <Button
            variant="primary"
            onClick={() => navigate('/websites?create=1')}
            className="sf-page-action"
          >
            <PlusIcon size={15} />
            {messages.websites.newAction}
          </Button>
        }
      />

      <div className="sf-kpi-grid">
        <KpiTile
          label={messages.websites.kpiTotal}
          value={summary ? summary.total : '—'}
          hint={summary ? messages.websites.kpiTotalHint(summary.own, summary.client) : undefined}
        />
        <KpiTile
          label={messages.websites.kpiLive}
          value={summary ? summary.live : '—'}
          tone={summary && summary.live > 0 ? 'good' : 'neutral'}
        />
        <KpiTile
          label={messages.websites.kpiDraft}
          value={summary ? summary.draft : '—'}
          hint={messages.websites.kpiDraftHint}
          tone={summary && summary.draft > 0 ? 'warn' : 'neutral'}
        />
        <KpiTile
          label={messages.websites.kpiAttention}
          value={summary ? summary.failed + summary.approvals_open : '—'}
          hint={messages.websites.kpiAttentionHint}
          tone={summary && summary.failed > 0 ? 'bad' : 'neutral'}
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

        {showCreate ? (
          <Card>
            <CardHeader title={messages.websites.createTitle} meta={messages.websites.createHint} />
            <div className="sf-card-body">
              <form className="sf-form-grid" onSubmit={handleCreate}>
                <Field
                  label={messages.websites.nameLabel}
                  error={fieldErrors.name}
                  htmlFor="sf-site-name"
                >
                  <Input
                    id="sf-site-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={messages.websites.namePlaceholder}
                    invalid={Boolean(fieldErrors.name)}
                    disabled={creating}
                    required
                  />
                </Field>
                <Field
                  label={messages.websites.domainLabel}
                  error={fieldErrors.domain}
                  htmlFor="sf-site-domain"
                >
                  <Input
                    id="sf-site-domain"
                    value={domain}
                    onChange={(event) => setDomain(event.target.value)}
                    placeholder={messages.websites.domainPlaceholder}
                    invalid={Boolean(fieldErrors.domain)}
                    disabled={creating}
                  />
                </Field>
                <Field label={messages.websites.clientLabel} htmlFor="sf-site-client">
                  <select
                    id="sf-site-client"
                    className="sf-input"
                    value={clientId}
                    onChange={(event) => setClientId(event.target.value)}
                    disabled={creating}
                  >
                    <option value="">{messages.websites.clientNone}</option>
                    {clients.map((client) => (
                      <option key={client.id} value={client.id}>
                        {client.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={creating || name.trim().length < 2}
                >
                  {creating ? messages.websites.creating : messages.websites.createSubmit}
                </Button>
              </form>
            </div>
          </Card>
        ) : null}

        <Card>
          <CardHeader
            title={messages.websites.listTitle}
            meta={list ? messages.websites.listSummary(items.length, total) : undefined}
          />
          <div className="sf-toolbar">
            <div className="sf-tabs" role="group" aria-label={messages.websites.filterLabel}>
              {(
                [
                  ['all', messages.websites.filterAll, summary?.total],
                  ['own', messages.websites.filterOwn, summary?.own],
                  ['client', messages.websites.filterClient, summary?.client],
                ] as const
              ).map(([value, label, count]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={filter === value}
                  className={filter === value ? 'sf-tab sf-tab-active' : 'sf-tab'}
                  onClick={() => {
                    setFilter(value);
                    setCursorStack([]);
                  }}
                >
                  <span>{label}</span>
                  <span className="sf-tab-count">{count ?? '—'}</span>
                </button>
              ))}
            </div>
            <div className="sf-search-wrap">
              <Input
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setCursorStack([]);
                }}
                placeholder={messages.websites.searchPlaceholder}
                aria-label={messages.websites.searchLabel}
                maxLength={80}
              />
            </div>
          </div>

          {loading ? (
            <div className="sf-card-body">
              <span className="numeric">{messages.common.loadingPlatform}</span>
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              title={messages.websites.emptyTitle}
              description={
                hasFilters ? messages.websites.emptyFiltered : messages.websites.emptyInitial
              }
              action={
                <Button variant="primary" onClick={() => navigate('/websites?create=1')}>
                  {messages.websites.newAction}
                </Button>
              }
            />
          ) : (
            <>
              <div className="sf-table-wrap">
                <table className="sf-table">
                  <thead>
                    <tr>
                      <th scope="col" className="label">
                        {messages.websites.colSite}
                      </th>
                      <th scope="col" className="label">
                        {messages.websites.colOwner}
                      </th>
                      <th scope="col" className="label">
                        {messages.websites.colStatus}
                      </th>
                      <th scope="col" className="label">
                        {messages.websites.colBuild}
                      </th>
                      <th scope="col" className="label sf-table-actions">
                        {messages.websites.colAction}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((site) => (
                      <tr key={site.id}>
                        <td>
                          <div className="sf-tenant-name">{site.name}</div>
                          <div className="numeric sf-tenant-slug">{site.domain ?? site.slug}</div>
                        </td>
                        <td>
                          {site.client_name ? (
                            site.client_name
                          ) : (
                            <span className="label">{messages.websites.ownerOwn}</span>
                          )}
                        </td>
                        <td>
                          <Badge tone={siteStatusTone(site.status)}>
                            {messages.websites.statusLabels[site.status]}
                          </Badge>
                        </td>
                        <td>
                          {site.last_build ? (
                            <div>
                              <div className="numeric">
                                {formatDateShort(site.last_build.created_at, locale)}
                              </div>
                              <div className="label">
                                {messages.websites.buildStatusLabels[site.last_build.status]}
                              </div>
                            </div>
                          ) : (
                            <span className="label">{messages.websites.noBuild}</span>
                          )}
                        </td>
                        <td className="sf-table-actions">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => navigate(`/websites/${site.id}`)}
                          >
                            {messages.websites.openAction}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="sf-pagination">
                <span className="numeric">
                  {messages.websites.pageStatus(startIndex, endIndex, total)}
                </span>
                <div className="sf-pagination-buttons">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={cursorStack.length === 0}
                    onClick={() => setCursorStack((prev) => prev.slice(0, -1))}
                  >
                    {messages.websites.prevPage}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!list?.nextCursor}
                    onClick={() => {
                      if (!list?.nextCursor) return;
                      const next = list.nextCursor;
                      setCursorStack((prev) => [...prev, next]);
                    }}
                  >
                    {messages.websites.nextPage}
                  </Button>
                </div>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
