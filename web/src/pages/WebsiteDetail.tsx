import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmModal,
  Field,
  Input,
  PageHeader,
} from '../components/ui';
import { ApiError, api, isAbortError } from '../lib/api';
import { formatApiError, formatDateTime, type Locale, type Messages } from '../lib/i18n';
import {
  approvalStateTone,
  canPublish,
  formatBuildDuration,
  siteStatusTone,
} from '../lib/websites';
import { navigate } from '../lib/router';
import type {
  Role,
  WebsiteApproval,
  WebsiteApprovalLink,
  WebsiteBuild,
  WebsiteDetail,
  WebsitePage,
} from '../lib/types';

export interface WebsiteDetailPageProps {
  siteId: string;
  role: Role;
  locale: Locale;
  messages: Messages;
}

export function WebsiteDetailPage({ siteId, role, locale, messages }: WebsiteDetailPageProps) {
  const [detail, setDetail] = useState<WebsiteDetail | null>(null);
  const [pages, setPages] = useState<WebsitePage[]>([]);
  const [builds, setBuilds] = useState<WebsiteBuild[]>([]);
  const [approvals, setApprovals] = useState<WebsiteApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [approvalLink, setApprovalLink] = useState<WebsiteApprovalLink | null>(null);
  const [copied, setCopied] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);

  const [goal, setGoal] = useState('');
  const [pageList, setPageList] = useState('/, /kontakt');

  const load = useCallback(
    (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      Promise.all([
        api.getWebsite(siteId, signal),
        api.websitePages(siteId, signal),
        api.websiteBuilds(siteId, signal),
        api.websiteApprovals(siteId, signal),
      ])
        .then(([site, sitePages, siteBuilds, siteApprovals]) => {
          setDetail(site);
          setPages(sitePages);
          setBuilds(siteBuilds);
          setApprovals(siteApprovals);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (isAbortError(err)) return;
          setError(formatApiError(err, locale));
          setLoading(false);
        });
    },
    [siteId, locale],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const lastBuild = builds[0] ?? null;
  const lastBuildOk = lastBuild?.status === 'ok';
  const currentApproval =
    lastBuild === null
      ? null
      : (approvals.find((entry) => entry.build_id === lastBuild.id) ?? null);
  const publishable = canPublish(role, lastBuild, approvals);

  async function handlePublish(): Promise<void> {
    if (!lastBuild) return;
    setBusy('publish');
    setError(null);
    setFeedback(null);
    try {
      const release = await api.publishWebsite(siteId, lastBuild.id);
      setFeedback(messages.websites.publishDone(release.version));
      load();
    } catch (err) {
      setError(formatApiError(err, locale));
    } finally {
      setBusy(null);
    }
  }

  async function handleRequestApproval(): Promise<void> {
    if (!lastBuild) return;
    setBusy('approval');
    setError(null);
    setFeedback(null);
    try {
      const link = await api.createWebsiteApproval(siteId, { build_id: lastBuild.id });
      setApprovalLink(link);
      setFeedback(messages.websites.approvalCreated);
      load();
    } catch (err) {
      setError(formatApiError(err, locale));
    } finally {
      setBusy(null);
    }
  }

  async function handleCopy(): Promise<void> {
    if (!approvalLink) return;
    try {
      await navigator.clipboard.writeText(approvalLink.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setError(messages.websites.copyFailed);
    }
  }

  async function handleBuild(): Promise<void> {
    setBusy('build');
    setError(null);
    setFeedback(null);
    try {
      await api.queueWebsiteBuild(siteId);
      setFeedback(messages.websites.buildQueued);
      load();
    } catch (err) {
      setError(formatApiError(err, locale));
    } finally {
      setBusy(null);
    }
  }

  async function handleBrief(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy('brief');
    setError(null);
    setFeedback(null);
    try {
      const routes = pageList
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      await api.createWebsiteJob(siteId, {
        goal: goal.trim(),
        ...(routes.length > 0 ? { pages: routes } : {}),
      });
      setGoal('');
      setFeedback(messages.websites.aiQueued);
      load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 402) {
        setError(messages.websites.aiBudget);
      } else {
        setError(formatApiError(err, locale));
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete(): Promise<void> {
    setBusy('delete');
    setError(null);
    try {
      await api.deleteWebsite(siteId);
      setPendingDelete(false);
      navigate('/websites');
    } catch (err) {
      setPendingDelete(false);
      setError(formatApiError(err, locale));
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div>
        <PageHeader title={messages.websites.detailTitleFallback} />
        <div className="sf-card-body">
          <span className="numeric" role="status">
            {messages.common.loadingPlatform}
          </span>
        </div>
      </div>
    );
  }

  if (error && detail === null) {
    return (
      <div>
        <PageHeader title={messages.websites.detailTitleFallback} />
        <div className="sf-alert sf-alert-bad" role="alert">
          <span>{error}</span>
        </div>
        <div style={{ marginTop: 'var(--spacing-lg)' }}>
          <Button variant="secondary" onClick={() => navigate('/websites')}>
            {messages.websites.backToAll}
          </Button>
        </div>
      </div>
    );
  }

  if (detail === null) return null;

  return (
    <div>
      <div style={{ marginBottom: 'var(--spacing-md)' }}>
        <Button variant="ghost" size="sm" onClick={() => navigate('/websites')}>
          ← {messages.websites.backToAll}
        </Button>
      </div>

      <PageHeader
        title={detail.name}
        description={detail.domain ?? detail.slug}
        actions={
          <div className="sf-page-actions">
            <Button variant="secondary" disabled={busy !== null} onClick={() => void handleBuild()}>
              {busy === 'build' ? messages.websites.buildStarting : messages.websites.buildAction}
            </Button>
            <Button
              variant="secondary"
              disabled={busy !== null || !lastBuildOk}
              title={lastBuildOk ? undefined : messages.websites.approvalNeedsBuild}
              onClick={() => void handleRequestApproval()}
            >
              {busy === 'approval'
                ? messages.websites.approvalRequesting
                : messages.websites.approvalRequest}
            </Button>
            {role === 'tenant_admin' ? (
              <Button
                variant="primary"
                disabled={busy !== null || !publishable}
                title={publishable ? undefined : messages.websites.publishBlocked}
                onClick={() => void handlePublish()}
              >
                {busy === 'publish'
                  ? messages.websites.publishing
                  : messages.websites.publishAction}
              </Button>
            ) : null}
          </div>
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

        {approvalLink ? (
          <Card>
            <CardHeader
              title={messages.websites.approvalLinkTitle}
              meta={messages.websites.approvalLinkHint}
            />
            <div className="sf-card-body">
              <div className="sf-form-grid">
                <Input
                  readOnly
                  value={approvalLink.url}
                  aria-label={messages.websites.approvalLinkTitle}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button variant="secondary" onClick={() => void handleCopy()}>
                  {copied ? messages.websites.copied : messages.websites.copyLink}
                </Button>
              </div>
            </div>
          </Card>
        ) : null}

        <div className="sf-settings-grid">
          <Card>
            <CardHeader
              title={messages.websites.detailProject}
              actions={
                <Badge tone={siteStatusTone(detail.status)}>
                  {messages.websites.statusLabels[detail.status]}
                </Badge>
              }
            />
            <div className="sf-card-body">
              <dl className="sf-kv-list">
                <div className="sf-kv-row">
                  <dt>{messages.websites.projectRepo}</dt>
                  <dd className="numeric">{detail.repo ?? messages.websites.projectNone}</dd>
                </div>
                <div className="sf-kv-row">
                  <dt>{messages.websites.projectBranch}</dt>
                  <dd className="numeric">{detail.branch ?? messages.websites.projectNone}</dd>
                </div>
                <div className="sf-kv-row">
                  <dt>{messages.websites.projectAstro}</dt>
                  <dd>
                    Astro {detail.astro_version}
                    {detail.deploy_target ? ` · ${detail.deploy_target}` : ''}
                  </dd>
                </div>
                <div className="sf-kv-row">
                  <dt>{messages.websites.detailRelease}</dt>
                  <dd>
                    {detail.release
                      ? messages.websites.releaseVersion(detail.release.version)
                      : messages.websites.releaseNone}
                  </dd>
                </div>
              </dl>
              {role === 'tenant_admin' ? (
                <div className="sf-card-foot" style={{ borderTop: 0, padding: '16px 0 0' }}>
                  <Button variant="ghost" size="sm" onClick={() => setPendingDelete(true)}>
                    {messages.websites.deleteAction}
                  </Button>
                </div>
              ) : null}
            </div>
          </Card>

          <Card>
            <CardHeader
              title={messages.websites.detailClient}
              meta={detail.client ? undefined : messages.websites.clientEmpty}
            />
            <div className="sf-card-body">
              {detail.client ? (
                <dl className="sf-kv-list">
                  <div className="sf-kv-row">
                    <dt>{messages.websites.clientName}</dt>
                    <dd>{detail.client.name}</dd>
                  </div>
                  <div className="sf-kv-row">
                    <dt>{messages.websites.clientContact}</dt>
                    <dd>{detail.client.contact_name ?? messages.websites.projectNone}</dd>
                  </div>
                  <div className="sf-kv-row">
                    <dt>{messages.websites.clientEmail}</dt>
                    <dd className="numeric">
                      {detail.client.contact_email ?? messages.websites.projectNone}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="sf-card-text">{messages.websites.clientEmptyHint}</p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader
              title={messages.websites.detailPages}
              meta={pages.length > 0 ? String(pages.length) : undefined}
            />
            <div className="sf-card-body">
              {pages.length === 0 ? (
                <p className="sf-card-text">{messages.websites.pagesEmpty}</p>
              ) : (
                <dl className="sf-kv-list">
                  {pages.map((page) => (
                    <div className="sf-kv-row" key={page.id}>
                      <dt className="numeric">{page.route}</dt>
                      <dd>
                        {page.title}{' '}
                        <span className="label">
                          · {messages.websites.pageOriginLabels[page.origin]}
                        </span>
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader
              title={messages.websites.detailBuilds}
              meta={lastBuild ? messages.websites.buildStatusLabels[lastBuild.status] : undefined}
            />
            <div className="sf-card-body">
              {builds.length === 0 ? (
                <p className="sf-card-text">{messages.websites.buildsEmpty}</p>
              ) : (
                <dl className="sf-kv-list">
                  {builds.slice(0, 5).map((build) => (
                    <div className="sf-kv-row" key={build.id}>
                      <dt className="numeric">{formatDateTime(build.created_at, locale)}</dt>
                      <dd>
                        {messages.websites.buildStatusLabels[build.status]}
                        {build.duration_ms !== null
                          ? ` · ${formatBuildDuration(build.duration_ms, locale)}`
                          : ''}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader
              title={messages.websites.detailApproval}
              actions={
                currentApproval ? (
                  <Badge tone={approvalStateTone(currentApproval.state)}>
                    {messages.websites.approvalStateLabels[currentApproval.state]}
                  </Badge>
                ) : undefined
              }
            />
            <div className="sf-card-body">
              {currentApproval ? (
                <dl className="sf-kv-list">
                  <div className="sf-kv-row">
                    <dt>{messages.websites.approvalExpiresLabel}</dt>
                    <dd className="numeric">
                      {formatDateTime(currentApproval.expires_at, locale)}
                    </dd>
                  </div>
                  <div className="sf-kv-row">
                    <dt>{messages.websites.approvalRecipient}</dt>
                    <dd>{currentApproval.recipient ?? messages.websites.projectNone}</dd>
                  </div>
                  {currentApproval.comment ? (
                    <div className="sf-kv-row">
                      <dt>{messages.websites.approvalComment}</dt>
                      <dd>{currentApproval.comment}</dd>
                    </div>
                  ) : null}
                </dl>
              ) : (
                <p className="sf-card-text">{messages.websites.approvalNone}</p>
              )}
              <p className="sf-card-text" style={{ marginTop: 'var(--spacing-md)' }}>
                {messages.websites.approvalHint}
              </p>
            </div>
          </Card>

          <Card>
            <CardHeader title={messages.websites.aiTitle} meta={messages.websites.aiHint} />
            <div className="sf-card-body">
              <form className="sf-form-grid" onSubmit={handleBrief}>
                <Field label={messages.websites.aiGoalLabel} htmlFor="sf-site-goal">
                  <Input
                    id="sf-site-goal"
                    value={goal}
                    onChange={(event) => setGoal(event.target.value)}
                    placeholder={messages.websites.aiGoalPlaceholder}
                    maxLength={200}
                    disabled={busy !== null}
                  />
                </Field>
                <Field
                  label={messages.websites.aiPagesLabel}
                  hint={messages.websites.aiPagesHint}
                  htmlFor="sf-site-pages"
                >
                  <Input
                    id="sf-site-pages"
                    value={pageList}
                    onChange={(event) => setPageList(event.target.value)}
                    placeholder="/, /zimmer, /kontakt"
                    disabled={busy !== null}
                  />
                </Field>
                <Button
                  type="submit"
                  variant="secondary"
                  disabled={busy !== null || goal.trim().length < 3}
                >
                  {busy === 'brief' ? messages.websites.aiSubmitting : messages.websites.aiSubmit}
                </Button>
              </form>
              <p className="sf-card-text" style={{ marginTop: 'var(--spacing-md)' }}>
                {messages.websites.aiRunnerNote}
              </p>
            </div>
          </Card>
        </div>
      </div>

      <ConfirmModal
        open={pendingDelete}
        title={messages.websites.deleteTitle(detail.name)}
        description={messages.websites.deleteBody}
        confirmLabel={messages.websites.deleteConfirm}
        cancelLabel={messages.common.cancel}
        closeLabel={messages.common.close}
        danger
        busy={busy === 'delete'}
        onConfirm={() => void handleDelete()}
        onCancel={() => setPendingDelete(false)}
      />
    </div>
  );
}
