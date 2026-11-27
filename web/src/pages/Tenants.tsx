import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { BuildingIcon } from '../components/icons';
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
import { useUiStore } from '../lib/store';
import {
  formatApiError,
  formatDateShort,
  formatFieldError,
  type Locale,
  type Messages,
} from '../lib/i18n';
import { navigate } from '../lib/router';
import type { Tenant, TenantListResponse, TenantStats, TenantStatus } from '../lib/types';

const PAGE_SIZE = 10;

type StatusFilter = 'all' | TenantStatus;

export interface TenantsPageProps {
  search: string;
  stats: TenantStats | null;
  locale: Locale;
  messages: Messages;
  onStatsChange: () => void;
}

export function TenantsPage({ search, stats, locale, messages, onStatsChange }: TenantsPageProps) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; slug?: string }>({});
  const [creating, setCreating] = useState(false);

  const { statusFilter, query } = useUiStore((state) => state.tenants);
  const setTenantFilter = useUiStore((state) => state.setTenantFilter);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [list, setList] = useState<TenantListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyTenantId, setBusyTenantId] = useState<string | null>(null);
  const [pendingSuspend, setPendingSuspend] = useState<Tenant | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const nameInputRef = useRef<HTMLInputElement>(null);
  const showToast = useToast();
  const currentCursor = cursorStack[cursorStack.length - 1] ?? null;

  useEffect(() => {
    const params = new URLSearchParams(search);
    if (params.get('create') === '1') {
      nameInputRef.current?.focus();
      navigate('/tenants', { replace: true });
    }
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    api
      .listTenants(
        {
          status: statusFilter === 'all' ? undefined : statusFilter,
          q: query,
          limit: PAGE_SIZE,
          cursor: currentCursor,
        },
        controller.signal,
      )
      .then((response) => {
        setList(response);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        setError(formatApiError(err, locale));
        setLoading(false);
      });

    return () => controller.abort();
  }, [statusFilter, query, currentCursor, reloadNonce, locale]);

  const refreshAll = useCallback(() => {
    setReloadNonce((n) => n + 1);
    onStatsChange();
  }, [onStatsChange]);

  function applyFilter(next: StatusFilter): void {
    setTenantFilter({ statusFilter: next });
    setCursorStack([]);
  }

  function applyQuery(next: string): void {
    setTenantFilter({ query: next });
    setCursorStack([]);
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFieldErrors({});
    setError(null);
    setCreating(true);

    try {
      const created = await api.createTenant({ name: name.trim(), slug });
      setName('');
      setSlug('');
      setCursorStack([]);
      showToast(messages.tenants.createdSuccess(created.name));
      refreshAll();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length > 0) {
        setFieldErrors({
          name: formatFieldError('name', err.fields.name, locale),
          slug: formatFieldError('slug', err.fields.slug, locale),
        });
        // The contract also allows a `form` key for a failure without a field
        // path. It belongs above the form; dropping it would leave the submit
        // silently unanswered.
        if (err.fields.form !== undefined) setError(messages.tenants.formInvalid);
      } else {
        setError(formatApiError(err, locale));
      }
    } finally {
      setCreating(false);
    }
  }

  async function handleSuspendConfirm(): Promise<void> {
    if (!pendingSuspend) return;
    const target = pendingSuspend;
    setBusyTenantId(target.id);
    setError(null);

    try {
      const updated = await api.suspendTenant(target.id);
      setPendingSuspend(null);
      showToast(messages.tenants.suspendedSuccess(updated.name));
      refreshAll();
    } catch (err) {
      setPendingSuspend(null);
      setError(formatApiError(err, locale));
    } finally {
      setBusyTenantId(null);
    }
  }

  async function handleResume(tenant: Tenant): Promise<void> {
    setBusyTenantId(tenant.id);
    setError(null);

    try {
      const updated = await api.resumeTenant(tenant.id);
      showToast(messages.tenants.resumedSuccess(updated.name));
      refreshAll();
    } catch (err) {
      setError(formatApiError(err, locale));
    } finally {
      setBusyTenantId(null);
    }
  }

  const items = list?.items ?? [];
  const total = list?.total ?? 0;
  const startIndex = items.length === 0 ? 0 : cursorStack.length * PAGE_SIZE + 1;
  const endIndex = cursorStack.length * PAGE_SIZE + items.length;
  const hasFilters = statusFilter !== 'all' || query.trim().length > 0;

  return (
    <div>
      <PageHeader title={messages.tenants.title} description={messages.tenants.description} />

      <div className="sf-kpi-grid-3">
        <KpiTile
          label={messages.overview.kpiTotal}
          value={stats ? stats.total : '—'}
          hint={messages.overview.kpiTotalHint}
          icon={<BuildingIcon size={15} />}
        />
        <KpiTile
          label={messages.overview.kpiActive}
          value={stats ? stats.active : '—'}
          hint={messages.overview.kpiActiveHint}
          tone={stats && stats.active > 0 ? 'good' : 'neutral'}
        />
        <KpiTile
          label={messages.overview.kpiSuspended}
          value={stats ? stats.suspended : '—'}
          hint={messages.overview.kpiSuspendedHint}
          tone={stats && stats.suspended > 0 ? 'bad' : 'neutral'}
        />
      </div>

      <div className="sf-stack">
        {error ? (
          <div className="sf-alert sf-alert-bad" role="alert">
            <span>{error}</span>
          </div>
        ) : null}

        <Card>
          <CardHeader title={messages.tenants.createTitle} />
          <div className="sf-card-body">
            <form className="sf-form-grid" onSubmit={handleCreate}>
              <Field
                label={messages.tenants.nameLabel}
                error={fieldErrors.name}
                htmlFor="sf-tenant-name"
              >
                <Input
                  ref={nameInputRef}
                  id="sf-tenant-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={messages.tenants.namePlaceholder}
                  invalid={Boolean(fieldErrors.name)}
                  disabled={creating}
                  required
                />
              </Field>

              <Field
                label={messages.tenants.slugLabel}
                hint={messages.tenants.slugHint}
                error={fieldErrors.slug}
                htmlFor="sf-tenant-slug"
              >
                <Input
                  id="sf-tenant-slug"
                  value={slug}
                  onChange={(event) => setSlug(event.target.value)}
                  placeholder={messages.tenants.slugPlaceholder}
                  invalid={Boolean(fieldErrors.slug)}
                  disabled={creating}
                />
              </Field>

              <Button type="submit" variant="primary" disabled={creating || name.trim().length < 2}>
                {creating ? messages.tenants.creating : messages.tenants.createSubmit}
              </Button>
            </form>
          </div>
        </Card>

        <Card>
          <CardHeader
            title={messages.tenants.listTitle}
            meta={list ? messages.tenants.listSummary(items.length, total) : undefined}
          />

          <div className="sf-toolbar">
            {/* Filters, not tabs: all three options stay visible and each one
                narrows the same list. `tablist` would promise arrow-key
                navigation and a `tabpanel` that do not exist. */}
            <div className="sf-tabs" role="group" aria-label={messages.tenants.colStatus}>
              <button
                type="button"
                aria-pressed={statusFilter === 'all'}
                onClick={() => applyFilter('all')}
                className={statusFilter === 'all' ? 'sf-tab sf-tab-active' : 'sf-tab'}
              >
                <span>{messages.tenants.filterAll}</span>
                <span className="sf-tab-count">{stats ? stats.total : '—'}</span>
              </button>
              <button
                type="button"
                aria-pressed={statusFilter === 'active'}
                onClick={() => applyFilter('active')}
                className={statusFilter === 'active' ? 'sf-tab sf-tab-active' : 'sf-tab'}
              >
                <span>{messages.tenants.filterActive}</span>
                <span className="sf-tab-count">{stats ? stats.active : '—'}</span>
              </button>
              <button
                type="button"
                aria-pressed={statusFilter === 'suspended'}
                onClick={() => applyFilter('suspended')}
                className={statusFilter === 'suspended' ? 'sf-tab sf-tab-active' : 'sf-tab'}
              >
                <span>{messages.tenants.filterSuspended}</span>
                <span className="sf-tab-count">{stats ? stats.suspended : '—'}</span>
              </button>
            </div>

            <div className="sf-search-wrap">
              {/* The server rejects longer terms with 422; capping the field
                  keeps the list request valid while typing. */}
              <Input
                type="search"
                value={query}
                onChange={(event) => applyQuery(event.target.value)}
                placeholder={messages.tenants.searchPlaceholder}
                aria-label={messages.tenants.searchLabel}
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
              title={messages.tenants.emptyTitle}
              description={
                hasFilters
                  ? messages.tenants.emptyFilteredDescription
                  : messages.tenants.emptyInitialDescription
              }
            />
          ) : (
            <>
              <div className="sf-table-wrap">
                <table className="sf-table">
                  <thead>
                    <tr>
                      <th scope="col" className="label">
                        {messages.tenants.colTenant}
                      </th>
                      <th scope="col" className="label">
                        {messages.tenants.colId}
                      </th>
                      <th scope="col" className="label">
                        {messages.tenants.colStatus}
                      </th>
                      <th scope="col" className="label">
                        {messages.tenants.colCreated}
                      </th>
                      <th scope="col" className="label sf-table-actions">
                        {messages.tenants.colAction}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((tenant) => {
                      const busy = busyTenantId === tenant.id;
                      return (
                        <tr key={tenant.id}>
                          <td>
                            <div className="sf-tenant-name">{tenant.name}</div>
                            <div className="numeric sf-tenant-slug">{tenant.slug}</div>
                          </td>
                          <td>
                            <span className="numeric">{tenant.id}</span>
                          </td>
                          <td>
                            <Badge tone={tenant.status === 'active' ? 'good' : 'bad'}>
                              {messages.tenants.statusLabels[tenant.status]}
                            </Badge>
                          </td>
                          <td>
                            <span className="numeric">
                              {formatDateShort(tenant.created_at, locale)}
                            </span>
                          </td>
                          <td className="sf-table-actions">
                            {tenant.status === 'active' ? (
                              <Button
                                variant="secondary"
                                size="sm"
                                disabled={busy}
                                onClick={() => setPendingSuspend(tenant)}
                              >
                                {messages.tenants.actionSuspend}
                              </Button>
                            ) : (
                              <Button
                                variant="secondary"
                                size="sm"
                                disabled={busy}
                                onClick={() => void handleResume(tenant)}
                              >
                                {messages.tenants.actionResume}
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="sf-pagination">
                <span className="numeric">
                  {messages.tenants.pageStatus(startIndex, endIndex, total)}
                </span>
                <div className="sf-pagination-buttons">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={cursorStack.length === 0}
                    onClick={() => setCursorStack((prev) => prev.slice(0, -1))}
                  >
                    {messages.tenants.prevPage}
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
                    {messages.tenants.nextPage}
                  </Button>
                </div>
              </div>
            </>
          )}
        </Card>
      </div>

      <ConfirmModal
        open={pendingSuspend !== null}
        title={pendingSuspend ? messages.tenants.confirmSuspendTitle(pendingSuspend.name) : ''}
        description={messages.tenants.confirmSuspendBody}
        confirmLabel={messages.tenants.confirmSuspendButton}
        cancelLabel={messages.common.cancel}
        closeLabel={messages.common.close}
        danger
        busy={pendingSuspend !== null && busyTenantId === pendingSuspend.id}
        onConfirm={() => void handleSuspendConfirm()}
        onCancel={() => setPendingSuspend(null)}
      />
    </div>
  );
}
