import { useEffect, useState } from 'react';
import { ActivityIcon, BuildingIcon } from '../components/icons';
import { Badge, Button, Card, CardHeader, EmptyState, KpiTile, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { formatApiError, formatDateShort, type Locale, type Messages } from '../lib/i18n';
import { AppLink, navigate } from '../lib/router';
import type { HealthResponse, SessionTenant, SessionUser, Tenant, TenantStats } from '../lib/types';

export interface OverviewPageProps {
  user: SessionUser;
  tenant: SessionTenant | null;
  health: HealthResponse | null;
  healthError: boolean;
  stats: TenantStats | null;
  locale: Locale;
  messages: Messages;
}

export function OverviewPage({
  user,
  tenant,
  health,
  healthError,
  stats,
  locale,
  messages,
}: OverviewPageProps) {
  const isOperator = user.role === 'operator';
  const [recent, setRecent] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(isOperator);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOperator) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    api
      .listTenants({ limit: 5 }, controller.signal)
      .then((response) => {
        setRecent(response.items);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(formatApiError(err, locale));
        setLoading(false);
      });

    return () => controller.abort();
  }, [isOperator, locale]);

  if (!isOperator) {
    return (
      <div>
        <PageHeader
          title={messages.overview.title}
          description={messages.overview.tenantDescription}
        />
        <div className="sf-stack">
          <Card>
            <CardHeader title={messages.overview.tenantCardTitle} />
            <div className="sf-card-body">
              <dl className="sf-kv-list">
                <div className="sf-kv-row">
                  <dt>{messages.overview.tenantLabel}</dt>
                  <dd className="numeric">
                    {tenant ? `${tenant.name} (${tenant.slug})` : messages.common.noTenant}
                  </dd>
                </div>
                <div className="sf-kv-row">
                  <dt>{messages.overview.roleLabel}</dt>
                  <dd>{messages.roles[user.role]}</dd>
                </div>
                <div className="sf-kv-row">
                  <dt>{messages.overview.accountLabel}</dt>
                  <dd className="numeric">{user.email}</dd>
                </div>
              </dl>
            </div>
          </Card>

          <Card>
            <CardHeader title={messages.overview.modulesTitle} />
            <EmptyState
              title={messages.overview.modulesEmptyTitle}
              description={messages.overview.modulesEmptyDescription}
            />
          </Card>
        </div>
      </div>
    );
  }

  const apiValue = healthError
    ? messages.shell.opsOffline
    : health?.status === 'ok'
      ? messages.shell.opsRunning
      : messages.shell.opsDegraded;
  const apiTone = healthError ? 'bad' : health?.status === 'ok' ? 'good' : 'warn';

  return (
    <div>
      <PageHeader
        title={messages.overview.title}
        description={messages.overview.operatorDescription}
      />

      <div className="sf-kpi-grid">
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
        <KpiTile
          label={messages.overview.kpiApi}
          value={apiValue}
          hint={health ? messages.overview.kpiApiHint(health.version) : undefined}
          tone={apiTone}
          icon={<ActivityIcon size={15} />}
        />
      </div>

      <Card>
        <CardHeader
          title={messages.overview.recentTenantsTitle}
          actions={
            <AppLink to="/tenants" className="sf-text-link">
              {messages.overview.manageTenantsLink}
            </AppLink>
          }
        />
        {error ? (
          <div className="sf-card-body">
            <div className="sf-alert sf-alert-bad" role="alert">
              <span>{error}</span>
            </div>
          </div>
        ) : loading ? (
          <div className="sf-card-body">
            <span className="numeric">{messages.common.loadingPlatform}</span>
          </div>
        ) : recent.length === 0 ? (
          <EmptyState
            title={messages.overview.emptyTenantsTitle}
            description={messages.overview.emptyTenantsDescription}
            action={
              <Button variant="secondary" onClick={() => navigate('/tenants?create=1')}>
                {messages.overview.emptyTenantsAction}
              </Button>
            }
          />
        ) : (
          <div className="sf-table-wrap">
            <table className="sf-table">
              <thead>
                <tr>
                  <th className="label">{messages.tenants.colTenant}</th>
                  <th className="label">{messages.tenants.colId}</th>
                  <th className="label">{messages.tenants.colStatus}</th>
                  <th className="label">{messages.tenants.colCreated}</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <div className="sf-tenant-name">{item.name}</div>
                      <div className="numeric sf-tenant-slug">{item.slug}</div>
                    </td>
                    <td>
                      <span className="numeric">{item.id}</span>
                    </td>
                    <td>
                      <Badge tone={item.status === 'active' ? 'good' : 'bad'}>
                        {messages.tenants.statusLabels[item.status]}
                      </Badge>
                    </td>
                    <td>
                      <span className="numeric">{formatDateShort(item.created_at, locale)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
