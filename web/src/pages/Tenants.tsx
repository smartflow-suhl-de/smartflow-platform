import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { BuildingIcon, CloseIcon } from '../components/icons';
import { useFocusTrap } from '../components/useFocusTrap';
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
  formatFieldError,
  type Locale,
  type Messages,
} from '../lib/i18n';
import { navigate } from '../lib/router';
import {
  TENANT_DETAIL_FIELDS,
  TENANT_DETAIL_MAX_LENGTH,
  type Tenant,
  type TenantDetailField,
  type TenantListResponse,
  type TenantStats,
  type TenantStatus,
} from '../lib/types';

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

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [list, setList] = useState<TenantListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyTenantId, setBusyTenantId] = useState<string | null>(null);
  const [pendingSuspend, setPendingSuspend] = useState<Tenant | null>(null);
  const [editingTenant, setEditingTenant] = useState<Tenant | null>(null);
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
    setStatusFilter(next);
    setCursorStack([]);
  }

  function applyQuery(next: string): void {
    setQuery(next);
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
                      const place = [tenant.details.postal_code, tenant.details.city]
                        .filter((part): part is string => Boolean(part))
                        .join(' ');
                      const contact = tenant.details.contact_name;
                      return (
                        <tr key={tenant.id}>
                          <td>
                            <div className="sf-tenant-name">{tenant.name}</div>
                            <div className="numeric sf-tenant-slug">{tenant.slug}</div>
                            {place || contact ? (
                              <div className="sf-tenant-meta">
                                {[place, contact].filter(Boolean).join(' · ')}
                              </div>
                            ) : null}
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
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() => setEditingTenant(tenant)}
                            >
                              {messages.tenants.actionEdit}
                            </Button>
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

      {editingTenant ? (
        <TenantDetailsModal
          tenant={editingTenant}
          locale={locale}
          messages={messages}
          onClose={() => setEditingTenant(null)}
          onSaved={(updated) => {
            setEditingTenant(null);
            showToast(messages.tenants.savedSuccess(updated.name));
            refreshAll();
          }}
        />
      ) : null}

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

type DetailSectionKey =
  'sectionAddress' | 'sectionContact' | 'sectionContactCompany' | 'sectionTax';

const DETAIL_SECTIONS: Array<{ title: DetailSectionKey; fields: TenantDetailField[] }> = [
  {
    title: 'sectionAddress',
    fields: ['street', 'address_extra', 'postal_code', 'city', 'country'],
  },
  {
    title: 'sectionContact',
    fields: ['contact_name', 'contact_role', 'contact_email', 'contact_phone', 'contact_mobile'],
  },
  { title: 'sectionContactCompany', fields: ['email', 'phone', 'website'] },
  { title: 'sectionTax', fields: ['vat_id', 'tax_number', 'register_court', 'register_number'] },
];

type DetailValues = Record<TenantDetailField, string>;
type DetailErrors = Partial<Record<TenantDetailField | 'name' | 'slug' | 'form', string>>;

/** The API answers in English; the mask speaks the operator's language. */
function detailFieldError(field: TenantDetailField, raw: string, locale: Locale): string {
  if (locale === 'en') return raw;
  if (field === 'contact_email' || field === 'email') {
    return 'Bitte eine gültige E-Mail-Adresse eingeben.';
  }
  if (field === 'postal_code') return 'Bitte eine gültige Postleitzahl eingeben.';
  return `Eingabe zu lang (max. ${TENANT_DETAIL_MAX_LENGTH[field]} Zeichen).`;
}

function detailValues(tenant: Tenant): DetailValues {
  const values = {} as DetailValues;
  for (const field of TENANT_DETAIL_FIELDS) values[field] = tenant.details[field] ?? '';
  return values;
}

interface TenantDetailsModalProps {
  tenant: Tenant;
  locale: Locale;
  messages: Messages;
  onClose: () => void;
  onSaved: (tenant: Tenant) => void;
}

/**
 * Master data of one tenant. Every field is optional; an empty input is sent
 * as `null` and clears the stored value, which is why the payload is built
 * from the full field list instead of the changed keys.
 */
function TenantDetailsModal({
  tenant,
  locale,
  messages,
  onClose,
  onSaved,
}: TenantDetailsModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(tenant.name);
  const [slug, setSlug] = useState(tenant.slug);
  const [values, setValues] = useState<DetailValues>(() => detailValues(tenant));
  const [errors, setErrors] = useState<DetailErrors>({});
  const [saving, setSaving] = useState(false);

  useFocusTrap(dialogRef, true, { onEscape: onClose, escapeDisabled: saving });

  function setValue(field: TenantDetailField, value: string): void {
    setValues((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrors({});
    setSaving(true);

    const details = Object.fromEntries(
      TENANT_DETAIL_FIELDS.map((field) => [field, values[field].trim() || null]),
    ) as Record<TenantDetailField, string | null>;

    try {
      const updated = await api.updateTenant(tenant.id, {
        name: name.trim(),
        slug: slug.trim(),
        details,
      });
      onSaved(updated);
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length > 0) {
        const next: DetailErrors = {};
        for (const [key, message] of Object.entries(err.fields)) {
          if (key === 'name') {
            next.name = locale === 'de' ? 'Bitte 2 bis 80 Zeichen eingeben.' : message;
          } else if (key === 'slug') {
            next.slug =
              locale === 'de'
                ? 'Nur Kleinbuchstaben, Ziffern und Bindestriche (2–48 Zeichen).'
                : message;
          } else if ((TENANT_DETAIL_FIELDS as readonly string[]).includes(key)) {
            next[key as TenantDetailField] = detailFieldError(
              key as TenantDetailField,
              message,
              locale,
            );
          } else {
            next.form = message;
          }
        }
        setErrors(next);
      } else {
        setErrors({ form: formatApiError(err, locale) });
      }
      setSaving(false);
    }
  }

  function renderField(field: TenantDetailField) {
    return (
      <Field
        key={field}
        label={messages.tenants.detailLabels[field]}
        error={errors[field]}
        htmlFor={`sf-tenant-${field}`}
      >
        <Input
          id={`sf-tenant-${field}`}
          value={values[field]}
          onChange={(event) => setValue(field, event.target.value)}
          invalid={Boolean(errors[field])}
          disabled={saving}
          maxLength={TENANT_DETAIL_MAX_LENGTH[field]}
        />
      </Field>
    );
  }

  return (
    <>
      <div
        className="sf-overlay-backdrop"
        onClick={() => !saving && onClose()}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sf-tenant-details-title"
        tabIndex={-1}
        className="sf-modal sf-modal-wide"
      >
        <form onSubmit={handleSubmit}>
          <div className="sf-modal-head">
            <div>
              <h2 id="sf-tenant-details-title" className="sf-modal-title">
                {messages.tenants.editTitle(tenant.name)}
              </h2>
              <p className="sf-modal-desc">{messages.tenants.editHint}</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label={messages.common.close}
              disabled={saving}
              onClick={onClose}
            >
              <CloseIcon size={16} />
            </Button>
          </div>

          <div className="sf-modal-body sf-modal-body-scroll">
            {errors.form ? (
              <div className="sf-alert sf-alert-bad" role="alert">
                <span>{errors.form}</span>
              </div>
            ) : null}

            <div className="sf-detail-section">
              <h3 className="sf-detail-title label">{messages.tenants.sectionCompany}</h3>
              <div className="sf-form-2col">
                <Field
                  label={messages.tenants.nameEditLabel}
                  error={errors.name}
                  htmlFor="sf-tenant-name-edit"
                >
                  <Input
                    id="sf-tenant-name-edit"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    invalid={Boolean(errors.name)}
                    disabled={saving}
                    maxLength={80}
                    required
                  />
                </Field>
                <Field
                  label={messages.tenants.slugEditLabel}
                  hint={messages.tenants.slugEditHint}
                  error={errors.slug}
                  htmlFor="sf-tenant-slug-edit"
                >
                  <Input
                    id="sf-tenant-slug-edit"
                    value={slug}
                    onChange={(event) => setSlug(event.target.value)}
                    invalid={Boolean(errors.slug)}
                    disabled={saving}
                    maxLength={48}
                    required
                    className="numeric"
                  />
                </Field>
                {(
                  ['legal_name', 'legal_form', 'customer_number', 'industry'] as TenantDetailField[]
                ).map(renderField)}
              </div>
            </div>

            {DETAIL_SECTIONS.map((section) => (
              <div key={section.title} className="sf-detail-section">
                <h3 className="sf-detail-title label">{messages.tenants[section.title]}</h3>
                <div className="sf-form-2col">{section.fields.map(renderField)}</div>
              </div>
            ))}

            <div className="sf-detail-section">
              <h3 className="sf-detail-title label">{messages.tenants.sectionNotes}</h3>
              <Field
                label={messages.tenants.detailLabels.notes}
                error={errors.notes}
                htmlFor="sf-tenant-notes"
              >
                <textarea
                  id="sf-tenant-notes"
                  className={
                    errors.notes ? 'sf-input sf-textarea sf-input-invalid' : 'sf-input sf-textarea'
                  }
                  value={values.notes}
                  onChange={(event) => setValue('notes', event.target.value)}
                  placeholder={messages.tenants.notesPlaceholder}
                  disabled={saving}
                  maxLength={TENANT_DETAIL_MAX_LENGTH.notes}
                  rows={4}
                />
              </Field>
            </div>
          </div>

          <div className="sf-modal-foot">
            <Button variant="secondary" disabled={saving} onClick={onClose}>
              {messages.common.cancel}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={saving || name.trim().length < 2 || slug.trim().length < 2}
            >
              {saving ? messages.tenants.saving : messages.tenants.save}
            </Button>
          </div>
        </form>
      </div>
    </>
  );
}
